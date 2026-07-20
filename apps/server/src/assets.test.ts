import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeImageAsset, validateImageAsset } from "./assets.js";
import { PngRenderer } from "./render.js";

const orientedJpeg = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAABgAAAADoAQAAQAAABAAAAAAAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAEQgAEAAYAwERAAIRAQMRAf/EABYAAQEBAAAAAAAAAAAAAAAAAAcIBP/EACoQAAIBAwIDCAMBAAAAAAAAAAECAwQFEQcSAAYTCBQhIiQzQlEVIzEy/8QAGgEAAgIDAAAAAAAAAAAAAAAABQYACAIDB//EACYRAAIBAwQCAgIDAAAAAAAAAAECEQMFEgQGITEAIgcTFEEVcaH/2gAMAwEAAhEDEQA/AJf0/wBDvb9P9fHjPHxb0V/658pXT/Q72/T/AF8eJHj7or91z47DSX8HyXc6wQyo605jjeEYdXfyKwORjDMDn+jHBK26f8jWU6fETJnqByf8Hm/dG8f4jbut1gdgQhVSpghn9FIMiIZgZBkASJPHhhHftO9O90VzvlLUV8XVU2+3eqn6kfg0TBMiN8+UCQoM58fA4YLdtW73OGo0CFMezeog9ETywjn1B4/sTWLbtqvt4xbT0CEOPs3qsN0wmCwjk4BjH65E66ntaWy2xd35P5SkqqoxrtqLw4VY5Nx3K0URO4bRjPUUgt/kgeYbdlsu3C1O4av7qykj6qPPIBAyqMMUIcQy4s4EHEzxZ/bHxrqK5V7rqgqz0gmRHBDMBBn9YEQO5PBJ2jNcdWdQbXbbY18qOXrZW1XeRRcvsaNEESBdhdf2yKzOHIeQruUEAYXbzTRsl81NapXWaQECm3sIYgjLgKzDAexXgk44gkE58i2rb+3LVo7dRofY1ZmLPUOUhIOJSMO3UggAjAdkk+f/2Q==",
  "base64",
);
const translucentWebp = Buffer.from(
  "UklGRloAAABXRUJQVlA4WAoAAAAQAAAABgAABAAAQUxQSAoAAAABB1DAiAhERP8DVlA4ICoAAABwAQCdASoHAAUAAMASJaACdAG+gAD+xOwu0f/2AJ//sAT//YAn/XwwAAA=",
  "base64",
);
const orientedWebp = Buffer.from(
  "UklGRvACAABXRUJQVlA4WAoAAAAoAAAAFwAADwAASUNDUOABAAAAAAHgbGNtcwQgAABtbnRyUkdCIFhZWiAH4gADABQACQAOAB1hY3NwTVNGVAAAAABzYXdzY3RybAAAAAAAAAAAAAAAAAAA9tYAAQAAAADTLWhhbmR56b9WWj4BtoMjhVVG90+qAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApkZXNjAAAA/AAAACRjcHJ0AAABIAAAACJ3dHB0AAABRAAAABRjaGFkAAABWAAAACxyWFlaAAABhAAAABRnWFlaAAABmAAAABRiWFlaAAABrAAAABRyVFJDAAABwAAAACBnVFJDAAABwAAAACBiVFJDAAABwAAAACBtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAYAAAAcAEMAQwAwAABYWVogAAAAAAAA9tYAAQAAAADTLXNmMzIAAAAAAAEMPwAABd3///MmAAAHkAAA/ZL///uh///9ogAAA9wAAMBxWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEcGFyYQAAAAAAAwAAAAJmaQAA8qcAAA1ZAAAT0AAACltWUDhMJwAAAC8XwAMAuQpE9D92hYjofxiItG3QBMy/4cHDh0zaNtR251oQeV7dzABFWElGugAAAEV4aWYAAElJKgAIAAAABgASAQMAAQAAAAYAAAAaAQUAAQAAAFYAAAAbAQUAAQAAAF4AAAAoAQMAAQAAAAIAAAATAgMAAQAAAAEAAABphwQAAQAAAGYAAAAAAAAAOGMAAOgDAAA4YwAA6AMAAAYAAJAHAAQAAAAwMjEwAZEHAAQAAAABAgMAAKAHAAQAAAAwMTAwAaADAAEAAAD//wAAAqAEAAEAAAAYAAAAA6AEAAEAAAAQAAAAAAAAAA==",
  "base64",
);
const sourcePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function animatedPng(source: Buffer): Buffer {
  const headerEnd = 8 + 12 + source.readUInt32BE(8);
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  animationControl.writeUInt32BE(0, 4);
  return Buffer.concat([source.subarray(0, headerEnd), pngChunk("acTL", animationControl), source.subarray(headerEnd)]);
}

function multiPictureJpeg(source: Buffer): Buffer {
  return Buffer.concat([
    source.subarray(0, 2),
    Buffer.from([0xff, 0xe2, 0x00, 0x06, 0x4d, 0x50, 0x46, 0x00]),
    source.subarray(2),
  ]);
}

function pngChunkTypes(data: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    types.push(data.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

describe("raster asset normalization", () => {
  let renderer: PngRenderer;

  beforeAll(() => {
    renderer = new PngRenderer({
      timeoutMs: 10_000,
      maxPixels: 1_000_000,
      concurrency: 1,
      queueLimit: 2,
      allowSoftwareFallback: false,
      allowSystemChrome: false,
    });
  });

  afterAll(async () => {
    await renderer.close();
  });

  it("fully decodes, applies orientation, strips metadata, and deterministically emits canonical PNG", async () => {
    const limits = { maxBytes: 1_000_000, maxPixels: 1_000_000 };
    const first = await normalizeImageAsset(orientedJpeg, "image/jpeg", limits, renderer);
    const second = await normalizeImageAsset(orientedJpeg, "image/jpeg", limits, renderer);

    expect(first.data.equals(second.data)).toBe(true);
    expect(first).toMatchObject({ mimeType: "image/png", width: 16, height: 24 });
    const chunkTypes = pngChunkTypes(first.data);
    expect(chunkTypes).toEqual(expect.arrayContaining(["IHDR", "IDAT", "IEND"]));
    expect(chunkTypes.some((type) => ["eXIf", "iCCP", "tEXt", "zTXt", "iTXt"].includes(type))).toBe(false);
  });

  it("normalizes WebP alpha through the isolated Chromium decoder", async () => {
    const normalized = await normalizeImageAsset(
      translucentWebp,
      "image/webp",
      { maxBytes: 1_000_000, maxPixels: 1_000_000 },
      renderer,
    );
    expect(normalized).toMatchObject({ mimeType: "image/png", width: 7, height: 5 });
  });

  it("applies WebP EXIF orientation before emitting canonical PNG", async () => {
    const normalized = await normalizeImageAsset(
      orientedWebp,
      "image/webp",
      { maxBytes: 1_000_000, maxPixels: 1_000_000 },
      renderer,
    );
    expect(normalized).toMatchObject({ mimeType: "image/png", width: 16, height: 24 });
  });

  it("rejects SVG, malformed bytes, MIME mismatches, excessive pixels, and multi-frame rasters", async () => {
    await expect(normalizeImageAsset(Buffer.from("<svg><script>alert(1)</script></svg>"), "image/svg+xml", {
      maxBytes: 1_000_000,
      maxPixels: 1_000_000,
    }, renderer)).rejects.toMatchObject({ code: "UNSUPPORTED_ASSET" });

    expect(() => validateImageAsset(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", {
      maxBytes: 1_000_000,
      maxPixels: 1_000_000,
    })).toThrow(/Only valid PNG/);

    await expect(normalizeImageAsset(orientedJpeg, "image/png", { maxBytes: 1_000_000, maxPixels: 1_000_000 }, renderer))
      .rejects.toMatchObject({ code: "UNSUPPORTED_ASSET" });
    await expect(normalizeImageAsset(orientedJpeg, "image/jpeg", { maxBytes: 1_000_000, maxPixels: 50 }, renderer))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(() => validateImageAsset(animatedPng(sourcePng), "image/png", {
      maxBytes: 1_000_000,
      maxPixels: 1_000_000,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ASSET" }));

    const animatedWebp = Buffer.from(translucentWebp);
    animatedWebp[20] = animatedWebp[20]! | 0x02;
    expect(() => validateImageAsset(animatedWebp, "image/webp", {
      maxBytes: 1_000_000,
      maxPixels: 1_000_000,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ASSET" }));
    expect(() => validateImageAsset(multiPictureJpeg(orientedJpeg), "image/jpeg", {
      maxBytes: 1_000_000,
      maxPixels: 1_000_000,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ASSET" }));
  });
});
