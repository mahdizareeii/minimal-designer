# Redesign Studio

Redesign Studio now has a persisted seven-stage workflow foundation. The
dashboard requires explicit selection of a current design and one active
single-platform Workspace Bridge inventory, then opens a dedicated browser
workspace. Every stage revision and decision is immutable and audited;
one-click creation records `sourceMutation: "none"` and never scans or rewrites
source.

The required stages are:

1. connect and inspect an explicitly authorized repository;
2. document current product, navigation, roles, entities, components, tokens,
   assets, localization, accessibility, duplication, and constraints;
3. run a redesign-focused product-manager interview;
4. preview a future-state information architecture, system, screen plan,
   migration phases, risks, and open questions;
5. design approved tokens, components, screens, states, and prototypes;
6. create a revision-pinned handoff and acceptance criteria;
7. implement one separately approved slice through an authorized code agent.

“One click” may create only an assessment/planning workflow. Assessment,
proposal, design, handoff, and implementation permissions must remain
independent.

The service enforces separate read, assessment, review, interview, proposal,
design, handoff, approval, implementation, and cancellation scopes. Stage
transitions use CAS checks against both assessment and optional design versions,
and REST/MCP expose create, read, revise, and transition operations. The browser
shows the seven-stage track, immutable activity, current evidence, return,
advance, approval, completion, and cancellation actions.

Entry into the future-state proposal additionally requires the exact current
design revision/version, the sole active bound inventory, and at least one
immutable implementation mapping. The server verifies the mapping's revision
and snapshot hashes, canonical product-specification pin, inventory hash/
fingerprint/platform, exact design entity, and opaque source entity. Missing,
stale, or forged evidence fails closed; return and cancellation remain
available.

This remains a foundation rather than a complete redesign program: historical
design-only assessments need safe inventory attachment/recreation UX, automatic
mapping suggestions and incremental rescans are absent, and the full real-
repository browser program, independently approved implementation decisions,
portable mapping handoff, and permission/revocation E2E matrix remain
incomplete.
