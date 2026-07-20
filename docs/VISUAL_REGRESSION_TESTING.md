# Visual regression browser test

FormaSpec has a bounded Playwright screenshot suite for the structured DOM renderer used by the editor's prototype preview.

Run the approved baselines from the repository root:

```bash
pnpm test:e2e:visual
```

When an intentional visual change has been reviewed, regenerate the baseline PNGs with:

```bash
pnpm test:e2e:visual:update
pnpm test:e2e:visual
```

Review every changed PNG before accepting it. Baselines live in `apps/server/e2e/visual-regression-snapshots/`; Playwright traces, actual images, and diff images are written under the ignored `test-results/visual-regression/` directory.

The command builds core, web, and server, starts an isolated loopback server with an in-memory SQLite database, and runs one serial browser worker at device pixel ratio 1. It does not reuse the normal FormaSpec server or write normal project data. On macOS it defaults to the installed Google Chrome channel; Linux and the Playwright container use the pinned Playwright Chromium unless `FORMASPEC_E2E_BROWSER_CHANNEL` selects another installed channel.

The deterministic fixtures cover:

- a 1440 × 900 desktop operations dashboard;
- a 390 × 844 phone finance flow;
- an 834 × 1194 tablet care-operations workspace;
- a 920 × 720 Persian RTL operations dashboard using Vazirmatn;
- an Inter/Vazirmatn typography and mixed-direction specimen;
- nested rounded clipping with rotated overflow geometry;
- an editorial screen using the normal upload, authorization, normalization, asset lookup, image decode, and object-fit path.

The assertions capture the native-size `.prototype-frame`, wait for bundled fonts and raster images to decode, disable animation, force sRGB/grayscale text rendering flags, and permit at most a 0.1% changed-pixel ratio with a per-pixel threshold of 0.12. A larger change fails with actual/expected/diff evidence.

## Stability boundary

The checked-in PNGs were generated and immediately reverified with Google Chrome at DPR 1 on macOS. The seven fixtures passed unchanged in a fresh second run. Pixel output can still vary across operating-system text rasterizers, Chrome versus bundled Chromium revisions, GPU configurations, and font-rendering implementations. Treat a failure on a new platform as evidence to inspect, not permission to overwrite the approved images. A release-grade CI matrix should keep separately reviewed baselines per supported browser/OS combination or run screenshots inside one pinned container image.

This is a representative foundation, not the full enterprise release gate. It currently covers one Chromium-family browser, DPR 1, one viewport, native-size prototype rendering, and seven fixtures. Cross-browser/OS baselines, DPR 2, full light/dark/high-contrast parity, every component state, editor chrome/interactions, revision restore, responsive breakpoint behavior, and the complete RTL/accessibility matrix remain required before production readiness can be declared.
