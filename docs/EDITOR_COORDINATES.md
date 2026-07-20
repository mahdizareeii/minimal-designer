# Editor coordinate system

Last audited: 2026-07-19

This document records the reproduced selection-overlay defect and the coordinate
contract required to fix it. The contract is approved; the current editor does
not yet satisfy it.

## Reproduced defect

The defect was reproduced on a rectangle at approximately 149% zoom:

1. Select the rectangle.
2. Confirm the Moveable border is initially aligned within roughly 0.5 CSS px.
3. Pan the canvas without changing the selection.
4. Observe that the node moves with the canvas while the Moveable border remains
   close to its old screen position.

Observed values:

| Measurement | Value |
| --- | --- |
| Zoom | approximately 149% |
| Canvas translation before pan | `(70, 143.875)` |
| Canvas translation after pan | `(-110, 3.875)` |
| Translation delta | `(-180, -140)` CSS px |
| Horizontal overlay error | approximately 179.5 CSS px |
| Vertical overlay error | approximately 139.5 CSS px |

The error matches the pan delta within measurement tolerance. This is strong
evidence that the target node uses the new canvas transform while Moveable uses
stale geometry.

## Current implementation

`Canvas.tsx` stores pan and zoom in the designer store and renders:

```text
canvas viewport (untransformed)
└── canvas world (translate then scale)
    └── design DOM nodes
```

Moveable and Selecto are mounted as children of the viewport. Moveable targets
are rediscovered when the document, selected IDs, or active page changes. That
effect does not depend on pan or zoom, no Moveable ref calls `updateRect()`, and
there is no dedicated untransformed interaction overlay.

Coordinate conversion is split among wheel handling, panning, Moveable event
values, DOM layout, and store updates. Drag and resize commits also round values
to integers and write through ordinary update commands.

## Required coordinate spaces

The corrected editor uses exactly three named spaces:

1. **Client space**: browser `clientX/clientY` coordinates.
2. **Editor space**: coordinates relative to the untransformed editor root.
3. **World space**: canonical design coordinates before pan and zoom.

Let `origin` be the editor root's client-space top-left, `pan` the editor-space
translation, and `zoom` the scalar zoom:

```text
editor = client - origin
editor = pan + world * zoom
world  = (editor - pan) / zoom
worldDelta = editorDelta / zoom
```

All tools must use one tested `ViewportTransform` implementation for these
conversions. No tool may independently reproduce this arithmetic.

## Required DOM contract

```text
editor root (positioned, untransformed)
├── canvas layer (translate3d(pan.x, pan.y, 0) scale(zoom))
│   ├── frame labels
│   └── stable node geometry wrappers
└── interaction overlay (absolute inset: 0, untransformed)
    ├── Selecto selection rectangle
    ├── Moveable controls
    ├── snapping guides
    ├── prototype hotspots
    └── future rulers and context menus
```

Requirements:

- Moveable is portaled into the interaction overlay.
- Moveable receives explicit `container` and `rootContainer` relationships.
- A selected target is a stable geometry wrapper, not an element whose identity
  changes because content rerendered.
- The canvas has one transform declaration:
  `translate3d(pan.x, pan.y, 0) scale(zoom)` with origin `0 0`.
- Overlay elements are never descendants of the transformed canvas layer.

## Geometry invalidation

Moveable geometry must be refreshed, coalesced to one animation frame, after:

- pan or zoom changes;
- viewport or nested scrolling;
- editor-root or target resize;
- document, layout, token, visibility, lock, page, or selection changes;
- font readiness or late font metric changes;
- image decode/load completion;
- DOM mutations that can change target geometry.

Use a Moveable ref and imperative `updateRect()` with coalesced
`ResizeObserver`, `MutationObserver`, and scroll-capture notifications. Observer
callbacks must be disconnected on unmount and must not cause render loops.

## Gesture rules

- Draft drag/resize geometry remains outside the canonical document until the
  gesture ends.
- One gesture produces exactly one normalized command/revision intent.
- Fractional world values and rotation are preserved; display rounding must not
  mutate canonical values.
- Multi-selection is reduced to canonical root nodes so a parent and its child
  are not transformed twice.
- Hidden and locked nodes are excluded from selection and guidelines.
- For absolute-layout children, dragging changes world `x/y`.
- For horizontal, vertical, or grid layout children, dragging means
  reorder/reparent. It must not write meaningless absolute coordinates.
- Resizing fixed dimensions may change width/height. Fill and hug dimensions
  change only through valid sizing constraints.
- Screen-space snapping thresholds are converted through
  `ViewportTransform`; they must feel consistent at every zoom.

## Performance contract

The current recursive renderer and guideline discovery are not proven for
1,000-node projects. No benchmark harness exists, so no baseline numbers are
recorded.

Phase 1 must add a representative 1,000-node fixture and measure:

- initial interactive load;
- selection response;
- pan and zoom frame time;
- drag and resize frame time;
- local commit/autosave;
- history load;
- 1440 by 900 PNG rendering;
- preview validation excluding rendering.

The release budgets are recorded in
[RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md).

## Acceptance matrix

Selection controls must remain within 0.75 CSS px of every selected object for:

- zoom levels 12%, 25%, 50%, 100%, 149%, 200%, and 320%;
- positive and negative pan;
- viewport and nested scrolling;
- DPR 1 and 2;
- rectangle, ellipse, text, image, frame, and nested nodes;
- LTR, RTL, and mixed-direction text;
- single and multi-selection;
- absolute, horizontal, vertical, and grid parents;
- font readiness and image-load transitions.

Tests must compare all four target and overlay edges before and after every
transform or layout event. A visual screenshot alone is not a sufficient
assertion.

## Current status

Status: **fixed for the verified Chrome foundation matrix; full release matrix
still open**.

`ViewportTransform`, the untransformed interaction overlay, stable target
wrappers, coalesced geometry invalidation, and imperative Moveable refresh are
implemented. Chrome at DPR 1/2 passes four browser tests covering the primary
zoom/pan/LTR/RTL/single/multi-selection alignment cases plus auto-layout
reorder, reparent, and constraint resize without x/y or rotation loss.

Release sign-off still requires the complete acceptance cross-product above,
including nested scroll, font/image transition cases, all node/layout types,
wrapped/grid edge cases, fractional group selection, and supported
cross-browser/OS evidence.
