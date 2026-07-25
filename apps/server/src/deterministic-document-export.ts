import { deflateSync, inflateSync } from "node:zlib";

import { DomainError } from "./errors.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_EXPORT_DIMENSION = 4_096;
const MAX_EXPORT_PIXELS = MAX_EXPORT_DIMENSION * MAX_EXPORT_DIMENSION;
const MAX_PNG_BYTES = 64 * 1024 * 1024;

export interface DecodedExportPng {
  width: number;
  height: number;
  rgb: Buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function exportValidation(message: string): DomainError {
  return new DomainError("PREVIEW_ENGINE_MISMATCH", message, 409, { retryable: true });
}

export function decodeRendererPngForExport(png: Buffer): DecodedExportPng {
  if (png.length < 57 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw exportValidation("The renderer did not return a bounded canonical PNG for export.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  const compressedParts: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_PNG_BYTES || chunkEnd > png.length) throw exportValidation("The renderer PNG has an invalid chunk boundary.");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const crcInput = png.subarray(offset + 4, offset + 8 + length);
    if (crc32(crcInput) !== png.readUInt32BE(offset + 8 + length)) {
      throw exportValidation("The renderer PNG failed its chunk checksum.");
    }
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw exportValidation("The renderer PNG is missing its canonical header.");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (width < 1 || height < 1 || width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION
        || width * height > MAX_EXPORT_PIXELS) {
        throw exportValidation("The renderer PNG dimensions exceed the deterministic export limit.");
      }
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)
        || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw exportValidation("The renderer PNG uses an unsupported color or interlace mode for deterministic export.");
      }
      bytesPerPixel = colorType === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (sawEnd) throw exportValidation("The renderer PNG contains image data after its end marker.");
      compressedParts.push(data);
      sawData = true;
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== png.length) throw exportValidation("The renderer PNG end marker is invalid.");
      sawEnd = true;
      break;
    } else if (/^[A-Z]/u.test(type) && !["PLTE"].includes(type)) {
      throw exportValidation(`The renderer PNG contains unsupported critical chunk ${type}.`);
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) throw exportValidation("The renderer PNG is incomplete.");

  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressedParts), {
      maxOutputLength: (width * bytesPerPixel + 1) * height,
    });
  } catch (error) {
    throw new DomainError("PREVIEW_ENGINE_MISMATCH", "The renderer PNG image stream could not be decoded safely.", 409, {
      retryable: true,
      cause: error,
    });
  }
  const rowBytes = width * bytesPerPixel;
  if (filtered.length !== (rowBytes + 1) * height) {
    throw exportValidation("The renderer PNG decoded to an unexpected byte length.");
  }
  const raw = Buffer.allocUnsafe(rowBytes * height);
  let filteredOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[filteredOffset++]!;
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = filtered[filteredOffset++]!;
      const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel]! : 0;
      const above = y > 0 ? raw[rowOffset - rowBytes + x]! : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? raw[rowOffset - rowBytes + x - bytesPerPixel]!
        : 0;
      let value: number;
      if (filter === 0) value = encoded;
      else if (filter === 1) value = encoded + left;
      else if (filter === 2) value = encoded + above;
      else if (filter === 3) value = encoded + Math.floor((left + above) / 2);
      else if (filter === 4) value = encoded + paeth(left, above, upperLeft);
      else throw exportValidation("The renderer PNG uses an unknown scanline filter.");
      raw[rowOffset + x] = value & 0xff;
    }
  }
  if (bytesPerPixel === 3) return { width, height, rgb: raw };
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let source = 0, target = 0; source < raw.length; source += 4, target += 3) {
    const alpha = raw[source + 3]!;
    rgb[target] = Math.round((raw[source]! * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 1] = Math.round((raw[source + 1]! * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 2] = Math.round((raw[source + 2]! * alpha + 255 * (255 - alpha)) / 255);
  }
  return { width, height, rgb };
}

export function deterministicSvgExport(png: Buffer, expectedWidth: number, expectedHeight: number): Buffer {
  const decoded = decodeRendererPngForExport(png);
  if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
    throw exportValidation("The renderer PNG dimensions do not match the export evidence.");
  }
  const base64 = png.toString("base64");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${decoded.width}" height="${decoded.height}" viewBox="0 0 ${decoded.width} ${decoded.height}"><image width="${decoded.width}" height="${decoded.height}" href="data:image/png;base64,${base64}"/></svg>`,
    "utf8",
  );
}

function pdfNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function deterministicPdfExport(png: Buffer, expectedWidth: number, expectedHeight: number): Buffer {
  const decoded = decodeRendererPngForExport(png);
  if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
    throw exportValidation("The renderer PNG dimensions do not match the export evidence.");
  }
  const image = deflateSync(decoded.rgb, { level: 9 });
  const pageWidth = decoded.width * 0.75;
  const pageHeight = decoded.height * 0.75;
  const content = Buffer.from(
    `q\n${pdfNumber(pageWidth)} 0 0 ${pdfNumber(pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`,
    "ascii",
  );
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = new Array<number>(6).fill(0);
  let length = chunks[0]!.length;
  const addObject = (id: number, bodies: readonly Buffer[]): void => {
    offsets[id] = length;
    const object = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, "ascii"),
      ...bodies,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(object);
    length += object.length;
  };
  addObject(1, [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii")]);
  addObject(2, [Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii")]);
  addObject(3, [Buffer.from(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(pageWidth)} ${pdfNumber(pageHeight)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    "ascii",
  )]);
  addObject(4, [
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`, "ascii"),
    image,
    Buffer.from("\nendstream", "ascii"),
  ]);
  addObject(5, [
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"),
    content,
    Buffer.from("endstream", "ascii"),
  ]);
  const xrefOffset = length;
  const xref = ["xref", "0 6", "0000000000 65535 f "];
  for (let id = 1; id <= 5; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  chunks.push(Buffer.from(
    `${xref.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  ));
  return Buffer.concat(chunks);
}
