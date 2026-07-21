import assert from "node:assert/strict";
import test from "node:test";

import {
  crossBrowserDockerArgs,
  parseCrossBrowserResult,
} from "./ci-cross-browser-docker-smoke.mjs";

test("parses only complete Firefox and WebKit passing output", () => {
  const parsed = parseCrossBrowserResult(
    "  ✓ [firefox-dpr-1] first\n  ✓ [webkit-dpr-1] second\n\n  12 passed (54.9s)\n",
  );
  assert.deepEqual(parsed, { passed: 12, firefox: true, webkit: true });
  assert.throws(() => parseCrossBrowserResult("12 passed (1s)\n"), /Firefox/u);
  assert.throws(() => parseCrossBrowserResult("[firefox-dpr-1]\n12 passed (1s)\n"), /WebKit/u);
  assert.throws(() => parseCrossBrowserResult("[firefox-dpr-1]\n[webkit-dpr-1]\n1 failed\n"), /passing summary/u);
});

test("builds an isolated, bounded, non-root-compatible Docker invocation", () => {
  const args = crossBrowserDockerArgs({
    containerName: "formaspectest",
    evidenceDirectory: "/tmp/formaspec-cross-browser-evidence",
    image: "formaspec/server:local",
  });
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", "formaspectest"]);
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges:true"));
  assert.ok(args.includes("seccomp=unconfined"));
  assert.ok(args.includes("HOME=/tmp/home"));
  assert.ok(args.includes("formaspec/server:local"));
  assert.match(args.at(-1), /playwright\.cross-browser\.config\.ts/u);
});
