# Performance testing

## Release-grade browser gate

The deterministic 1,000-node browser gate exercises the real editor and the full Chromium renderer:

```bash
pnpm test:e2e:performance
```

The root command builds core, web, and server before invoking the typed server
Playwright gate.

Install the exact browser revision declared by the server package before the first local run:

```bash
pnpm --filter @designer/server exec playwright install chromium
```

The gate uses at least 20 measured samples for every nearest-rank p95 and covers:

- cold initial editor interactivity after fonts and two painted frames, with Chromium's cache cleared before every sample;
- selection response through the selected DOM state and ready Moveable controls;
- 60 Hz cadence-normalized gesture frame budgets, plus raw frame pacing with no frame over 50 ms and separate main-thread input/React/layout work diagnostics;
- one real autosave and the shared explicit-save commit path;
- immutable history loading through the completed HTTP response and rendered rows;
- preview validation and persistence without calling a render endpoint;
- a full 1,440 × 900 PNG rendered by pinned Playwright Chromium.

Software rendering, system-browser fallback warnings, wrong PNG dimensions, fewer than 20 samples, and any exceeded release budget fail the test. A versioned JSON report is written below `test-results/browser-performance/` for every completed run. The default release budgets are 2.5 s p95 for initial load, 50 ms p95 for selection, 16.7 ms p95 and 50 ms maximum for gesture work/pacing, 500 ms p95 for commit/autosave, 1 s p95 for history and preview validation, and 5 s p95 with a 15 s hard timeout for Chromium rendering.

The final local macOS arm64 observation on 2026-07-20 used Node.js 24.14.0 and pinned Chromium 149.0.7827.55. All gates passed: cold interactive load p95 232.80 ms, selection p95 20.80 ms, cadence-normalized gesture frame p95 and maximum 16.70 ms, editor commit/autosave p95 261.90 ms, history p95 19.00 ms, preview validation p95 216.65 ms, and 1,440 × 900 Chromium render p95 199.22 ms.

Iteration counts can be raised with `FORMASPEC_BROWSER_PERF_ITERATIONS`, `FORMASPEC_BROWSER_PERF_WARMUP_ITERATIONS`, and `FORMASPEC_BROWSER_PERF_GESTURE_FRAMES`. The gate intentionally refuses fewer than 20 measured iterations.

## Service/core foundation

FormaSpec includes a bounded, deterministic 1,000-node performance foundation:

```bash
pnpm test:performance
```

The harness builds the same 1,000-node document on every run and reports nearest-rank p50 and p95 timings for:

- strict core document validation and structural linting;
- applying 25 typed updates, including result validation;
- server preview authorization, validation, canonical snapshot creation, diagnostics, and SQLite persistence;
- a 512 px server render with external requests blocked.

The current verified p95 results are 17.71 ms validation, 36.18 ms for 25
typed updates, 132.17 ms preview validation/persistence, and 118.12 ms for the
512 × 320 Playwright render.

Use `pnpm test:performance -- --skip-render` when Chromium or browser execution is intentionally unavailable. Use `--json` to emit a machine-readable versioned report. Iteration counts and the coarse regression ceilings can be tuned through the environment variables printed by `pnpm test:performance -- --help`.

## Interpretation

The default ceilings are deliberately broad foundation gates. They catch catastrophic regressions while the complete performance lab is being built. They are not evidence that the release budgets are satisfied.

In particular, this foundation harness does not measure initial browser interactivity, selection latency, gesture frame work, DPR behavior, visual correctness, or HTTP transport. Use the browser gate above plus the alignment and visual suites for those release requirements. The foundation report records whether the server render used Playwright or the development-only software fallback so the two modes are never conflated.

For a useful comparison, run the harness on an otherwise idle machine, retain the JSON report as a CI artifact, and compare the same renderer mode, Node version, architecture, iteration counts, and ceiling configuration.

## Initial foundation observation

The default harness was run on 2026-07-19 on macOS arm64 with Node.js 24.14.0. Seven measured core/preview samples followed two warmups; rendering used three measured samples after one warmup.

| Metric | p50 | p95 | Evidence boundary |
| --- | ---: | ---: | --- |
| Core document validation | 13.37 ms | 21.74 ms | Schema and structural lint only |
| Apply 25 typed updates | 35.54 ms | 43.82 ms | Includes source/result validation |
| Server preview validation and persistence | 89.93 ms | 119.03 ms | Service layer and in-memory SQLite; no HTTP |
| 512 px server render | 1.85 ms | 2.24 ms | Development-only software fallback, not Chromium |

These numbers establish a repeatable local comparison point only. The software-render result is not comparable to the release requirement for a full-fidelity 1,440×900 Chromium render, and none of the observations establish the browser interaction budgets.
