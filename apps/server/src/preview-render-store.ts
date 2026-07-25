import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DomainError } from "./errors.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_PREVIEW_RENDER_BYTES = 100_663_296;

function assertDigest(sha256: string): void {
  if (!SHA256.test(sha256)) {
    throw new DomainError("VALIDATION_FAILED", "Preview render SHA-256 is invalid.", 422);
  }
}

function artifactIntegrityError(
  sha256: string,
  message: string,
  details: Record<string, unknown> = {},
): DomainError {
  return new DomainError("PREVIEW_ENGINE_MISMATCH", message, 409, {
    retryable: true,
    details: {
      expectedSha256: sha256,
      recovery: "Reload the review to hydrate a verified legacy render, or regenerate the preview.",
      ...details,
    },
  });
}

/**
 * Stores exact preview PNG bytes outside SQLite under a digest-derived name.
 * Callers never provide a path, and reads verify both the regular-file
 * boundary and the content digest before bytes leave the service layer.
 */
export class ContentAddressedPreviewRenderStore {
  readonly root: string;

  constructor(
    dataDirectory: string,
    readonly maxBytes = DEFAULT_MAX_PREVIEW_RENDER_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Preview render storage requires a positive byte limit.");
    }
    this.root = path.resolve(dataDirectory, "preview-renders");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("Preview render storage root must be a real directory.");
    }
  }

  artifactPath(sha256: string): string {
    assertDigest(sha256);
    return path.join(this.root, `${sha256}.png`);
  }

  write(png: Buffer, expectedSha256: string): void {
    assertDigest(expectedSha256);
    if (!Buffer.isBuffer(png)
      || png.length < PNG_SIGNATURE.length
      || png.length > this.maxBytes
      || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new DomainError("VALIDATION_FAILED", "Exact preview render bytes are not a bounded PNG.", 422);
    }
    const observedSha256 = createHash("sha256").update(png).digest("hex");
    if (observedSha256 !== expectedSha256) {
      throw artifactIntegrityError(expectedSha256, "Exact preview render bytes do not match their persisted SHA-256.", {
        actualSha256: observedSha256,
      });
    }
    const destination = this.artifactPath(expectedSha256);
    const existing = this.read(expectedSha256);
    if (existing !== null) return;
    const temporary = path.join(this.root, `.${expectedSha256}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, png, { mode: 0o600, flag: "wx" });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows does not replace an existing destination during rename.
        // Another process may have won the same content-addressed write after
        // our initial read, so accept only a newly visible, fully verified
        // artifact. Any other rename failure remains actionable.
        if ((code !== "EEXIST" && code !== "EACCES" && code !== "EPERM")
          || this.read(expectedSha256) === null) {
          throw error;
        }
      }
      fs.chmodSync(destination, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  read(sha256: string): Buffer | null {
    const filename = this.artifactPath(sha256);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < PNG_SIGNATURE.length || stat.size > this.maxBytes) {
      throw artifactIntegrityError(sha256, "Stored exact preview render is not a safe bounded regular file.");
    }
    const bytes = fs.readFileSync(filename);
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (observedSha256 !== sha256 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw artifactIntegrityError(sha256, "Stored exact preview render failed its PNG or SHA-256 integrity check.", {
        actualSha256: observedSha256,
      });
    }
    return bytes;
  }

  cleanupUnreferenced(referencedSha256: ReadonlySet<string>, olderThanMs: number): number {
    if (!Number.isFinite(olderThanMs)) throw new Error("Preview render cleanup requires a finite retention timestamp.");
    let removed = 0;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      const match = /^([a-f0-9]{64})\.png$/.exec(entry.name);
      if (!match || referencedSha256.has(match[1]!)) continue;
      const filename = path.join(this.root, entry.name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > olderThanMs) continue;
      fs.rmSync(filename, { force: true });
      removed += 1;
    }
    return removed;
  }
}
