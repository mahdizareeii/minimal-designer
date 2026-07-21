# Editor coordinate system

Last audited: 2026-07-21

This document records the reproduced selection-overlay defect, the coordinate
contract used to fix it, and the current verified status.

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

## Baseline implementation at reproduction

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

A representative 1,000-node browser fixture and release-budget harness now
measure:

- initial interactive load;
- selection response;
- pan and zoom frame time;
- drag and resize frame time;
- local commit/autosave;
- history load;
- 1440 by 900 PNG rendering;
- preview validation excluding rendering.

The current exact-source run passes all recorded budgets. The harness remains
a local engineering gate until retained hosted and supported-platform evidence
exists. Exact thresholds and results are recorded in
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
implemented. Chrome at DPR 1/2 passes 12 browser checks covering every
required zoom endpoint (12/25/50/100/149/200/320%, plus 150%), fractional pan,
LTR/RTL/mixed text, nested rotated RTL, image geometry, fractional single and
multi-selection, hidden/locked exclusion, nested scrolling, font-ready and
image-load invalidation, one-revision fractional group drag, and auto-layout
reorder, reparent, and constraint resize without x/y or rotation loss.

React Moveable 0.56 rounds target offsets internally when it derives a group
rectangle. FormaSpec therefore keeps Moveable as the group drag/snapping engine
but draws the non-resizable multi-selection border from the exact union of the
selected targets' client rectangles. This prevents upstream world-coordinate
rounding from exceeding the 0.75 CSS px budget at high zoom.

The cross-browser gate also exposed a WebKit initial-fit race: the old delayed
`requestAnimationFrame` fit could run after an immediate user or test pan and
overwrite it. Initial fitting now runs synchronously in `useLayoutEffect` once
the editor root, document, and active page exist. The final reviewed image
passed Firefox/WebKit 12/12 once with summary SHA-256
`b4602ad1a40a6c32a73c118101a0b1b0d6970e8affcd939a18061939ed5c1aad`.
The immediately prior fit-sync image passed three consecutive 12/12 runs; its
main, `-repeat2`, and `-repeat3` summaries are byte-identical with SHA-256
`0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`.

Release sign-off still requires retained hosted and supported-OS evidence plus
the broader complete acceptance cross-product beyond the passing local Chrome,
Firefox, and WebKit foundations.
