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

- 25%, 100%, 150%, and 200% canvas zoom;
- positive, negative, and mixed fractional pan values;
- fractional-position LTR and RTL text nodes, plus a separate deterministic multi-selection union;
- geometry refresh while a single selection survives a pan/zoom change;
- geometry refresh while a multi-selection survives a pan change;
- single-child vertical auto-layout reorder and cross-container reparent;
- auto-layout fill-to-fixed resize without x/y mutation, including persisted
  fractional source geometry and rotation;
- browser contexts at device pixel ratio 1 and 2;
- direct comparison of selected target edges with the centers of Moveable's four rendered border lines, with a maximum error of 0.75 CSS px.

The test deliberately drives the editor's real layers-panel selection and wheel pan/zoom handlers. It does not expose a production test hook.

This is not the full release-blocking matrix. Fractional-coordinate
multi-selection remains limited by the current Moveable group implementation,
which rounds child offsets; scroll-container changes, image/font decode
transitions, rotated selection borders, every node/layout mode, wrapped/grid
edge cases, every supported browser/OS, and the complete zoom/pan/DPR
cross-product still need dedicated cases before the enterprise release gate can
be marked complete.
