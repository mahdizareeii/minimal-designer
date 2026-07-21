# Selection alignment browser test

FormaSpec has a real browser-level Playwright check for the editor's P0 target/Moveable alignment contract.

Run it from the repository root:

```bash
pnpm test:e2e:alignment
```

The command builds the shared core, web app, and server, starts an isolated loopback server with an in-memory SQLite database, and launches a headless Chromium browser. On macOS it defaults to the installed Google Chrome channel; Linux and the Playwright container use Playwright's bundled Chromium. Set `FORMASPEC_E2E_BROWSER_CHANNEL` to override the channel. It does not reuse a running FormaSpec server or modify normal project data.

If no compatible browser is installed, install the pinned Playwright Chromium runtime before running the suite:

```bash
pnpm --filter @designer/server exec playwright install chromium
```

Current deterministic coverage is a representative subset of the release matrix:

- 12%, 25%, 50%, 100%, 149%, 150%, 200%, and 320% canvas zoom;
- positive, negative, and mixed fractional pan values;
- fractional-position LTR, RTL, and mixed-direction text nodes;
- exact fractional multi-selection bounds at all zoom cases, including a
  one-revision group drag that preserves equal fractional deltas;
- geometry refresh while a single selection survives a pan/zoom change;
- geometry refresh while a multi-selection survives a pan change;
- nested scroll capture plus explicit font-ready and image-load invalidation;
- actual delayed bundled-font completion and a decoded normalized uploaded
  image;
- nested rotated RTL geometry, selectable frame and ellipse nodes, a decoded
  normalized uploaded image, and hidden/locked exclusion;
- single-child vertical auto-layout reorder and cross-container reparent at
  fractional 149% viewport geometry;
- auto-layout fill-to-fixed resize without x/y mutation, including persisted
  fractional source geometry and rotation;
- row-aware grid and horizontal-wrap reparent/insertion without x/y mutation;
- rotated multi-selection union geometry at 149% and 320%;
- browser contexts at device pixel ratio 1 and 2;
- direct comparison of selected target edges with Moveable's four rendered
  border lines for single selections, rotated corner-handle centers for rotated
  selections, and FormaSpec's exact client-rectangle union for non-resizable
  groups, with a maximum error of 0.75 CSS px.

The test deliberately drives the editor's real layers-panel selection and wheel pan/zoom handlers. It does not expose a production test hook.

The repository also defines the release-CI Firefox/WebKit functional matrix:

```bash
pnpm --filter @designer/server exec playwright install firefox webkit
pnpm test:e2e:alignment:cross-browser
```

The browser workflow installs the pinned runtimes and retains traces/screenshots
under a `NO-GO-*` artifact. The Docker workflow additionally runs the suite
against the exact image it just built and retains
`NO-GO-cross-browser-docker-*`. The final reviewed local image
`sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`
passed Firefox/WebKit 12/12 once in a network-disabled, read-only, non-root
Linux run; its summary is
`/private/tmp/formaspec-cross-browser-docker-20260721-final437-eventauth-sqlbounded-cli/summary.json`
with SHA-256
`2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`.
A delayed `requestAnimationFrame` initial fit could
previously overwrite immediate user or test pan in WebKit; initial fitting now
runs synchronously in `useLayoutEffect` once the editor root, document, and page
exist. The immediately prior fit-sync image
`sha256:544a1c72cecaaf335a750a0fd4775f03a11f185e90ad441b1503dfdfa1b8ddeb`
passed three consecutive 12/12 runs; its main summary is
`/private/tmp/formaspec-cross-browser-docker-20260721-final430-auth106-supervision-egress-fit-sync-runtime/summary.json`,
and the main, `-repeat2`, and `-repeat3` summaries are byte-identical with SHA-256
`0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`.
No GitHub-hosted or cross-OS Firefox/WebKit run is claimed by these local
checkpoints.

React Moveable still rounds group child offsets internally. FormaSpec retains
Moveable for group dragging and snapping but renders the non-resizable group
border from the exact target union, which is now covered at DPR 1 and 2.

This is not the full release-blocking matrix. Every supported browser/OS and
the complete node/layout/zoom/pan/DPR cross-product still need dedicated
evidence before the enterprise release gate can be marked complete.
