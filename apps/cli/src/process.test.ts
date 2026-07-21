import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCommand } from "./process.js";

describe("bounded command execution", () => {
  it("streams authorized stdin without placing it in process arguments", async () => {
    const payload = Buffer.from("offline restore bytes through stdin");
    const result = await runCommand(process.execPath, [
      "-e",
      "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)))",
    ], {
      input: Readable.from([payload]),
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 0, stdout: payload.toString("utf8"), stderr: "" });
  });

  it.each(["stdout", "stderr"] as const)("terminates a child that exceeds the combined %s output budget", async (stream) => {
    const script = stream === "stdout"
      ? "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"
      : "process.stderr.write('x'.repeat(8192));setInterval(()=>{},1000)";
    const startedAt = Date.now();
    await expect(runCommand(process.execPath, ["-e", script], {
      maxOutputBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow(/output exceeded the fixed 1024-byte limit/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("enforces one combined budget across stdout and stderr", async () => {
    await expect(runCommand(process.execPath, [
      "-e",
      "process.stdout.write('o'.repeat(600));process.stderr.write('e'.repeat(600));setInterval(()=>{},1000)",
    ], {
      maxOutputBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow(/output exceeded the fixed 1024-byte limit/);
  });

  it.skipIf(process.platform === "win32")(
    "uses SIGKILL when an over-budget child ignores SIGTERM",
    async () => {
      const startedAt = Date.now();
      await expect(runCommand(process.execPath, [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)",
      ], {
        maxOutputBytes: 1024,
        timeoutMs: 15_000,
      })).rejects.toThrow(/output exceeded the fixed 1024-byte limit/);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(8_000);
    },
    10_000,
  );
});
