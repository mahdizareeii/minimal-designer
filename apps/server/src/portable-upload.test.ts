import { createHash } from "node:crypto";
import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  portableUploadStagingRoot,
  stagePortableUploadStream,
  type PortableUploadFile,
} from "./portable-upload.js";

const uploads: PortableUploadFile[] = [];

afterEach(async () => {
  await Promise.all(uploads.splice(0).map((upload) => upload.cleanup()));
});

async function stagedDirectories(): Promise<string[]> {
  return fs.promises.readdir(portableUploadStagingRoot()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function* chunks(values: Buffer[]): AsyncGenerator<Buffer> {
  for (const value of values) yield value;
}

describe("portable upload streaming", () => {
  it("writes chunked input incrementally to a private no-follow file and removes it on cleanup", async () => {
    const before = await stagedDirectories();
    const values = [Buffer.from("Forma"), Buffer.from("Spec"), Buffer.from(" portable bundle")];
    const expected = Buffer.concat(values);
    const upload = await stagePortableUploadStream(chunks(values), 1024);
    uploads.push(upload);

    expect(upload.sizeBytes).toBe(expected.length);
    expect(upload.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(await fs.promises.readFile(upload.filename)).toEqual(expected);
    expect((await fs.promises.stat(upload.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.promises.stat(upload.filename)).mode & 0o777).toBe(0o600);

    await upload.cleanup();
    uploads.pop();
    expect(await stagedDirectories()).toEqual(before);
  });

  it("enforces actual bytes mid-stream and removes every partial file", async () => {
    let staged = "";
    await expect(stagePortableUploadStream(chunks([
      Buffer.alloc(31, 1),
      Buffer.alloc(31, 2),
      Buffer.alloc(31, 3),
    ]), 64, (directory) => { staged = directory; })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
    await expect(fs.promises.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes partial state when the producer aborts", async () => {
    let staged = "";
    async function* aborted(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(32, 7);
      throw new Error("client disconnected");
    }
    await expect(stagePortableUploadStream(aborted(), 1024, (directory) => { staged = directory; }))
      .rejects.toThrow("client disconnected");
    await expect(fs.promises.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates concurrent uploads and preserves exact independent hashes", async () => {
    const sources = Array.from({ length: 8 }, (_, index) => Buffer.alloc(257 + index, index));
    const concurrent = await Promise.all(sources.map((source) => stagePortableUploadStream(chunks([
      source.subarray(0, 17),
      source.subarray(17, 103),
      source.subarray(103),
    ]), 2048)));
    uploads.push(...concurrent);
    expect(new Set(concurrent.map((upload) => upload.directory)).size).toBe(sources.length);
    await Promise.all(concurrent.map(async (upload, index) => {
      expect(upload.sha256).toBe(createHash("sha256").update(sources[index]!).digest("hex"));
      expect(await fs.promises.readFile(upload.filename)).toEqual(sources[index]);
    }));
  });
});
