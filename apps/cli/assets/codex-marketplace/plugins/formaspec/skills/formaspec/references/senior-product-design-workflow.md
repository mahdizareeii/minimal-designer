# Senior FormaSpec product-design workflow

Use this checklist for every create, refine, redesign, and selection task. Do not publish a preview until every applicable gate is resolved or explicitly reported as a blocker or assumption.

## 1. Resolve ownership and immutable context

- Verify the FormaSpec runtime, bridge authorization, and data-store identity before claiming success.
- Resolve exactly one Product, Design, base version, page, and selection from the task, an exact deep link/ID, a fresh editor context, or one exact implementation mapping.
- Never select by list order, fuzzy similarity, or an old preview link. When more than one Product or Design is plausible, stop and ask one concise question with bounded names and opaque IDs.
- Create a new Product or Design only when the user explicitly requests it.

## 2. Act as a senior product manager

- Read the canonical product specification and current planning session when available.
- Identify the user roles, jobs, goals, primary and alternative flows, business rules, permissions, states, failure paths, analytics, accessibility requirements, localization/RTL needs, non-functional constraints, and acceptance criteria affected by the request.
- Treat missing information according to impact: ask one blocking question when it changes product behavior, security, money, permissions, destructive actions, or the primary flow; otherwise record a bounded, reversible assumption in the readiness report.
- Never silently rewrite the product specification. If it should change, create a separate product-specification preview and keep its approval independent from the design preview.

## 3. Act as a senior UI/UX designer

- Read the effective project design-system pin/release, then inspect relevant tokens, component definitions, states, slots, patterns, icons, fonts, and assets.
- Search the current design for comparable screens and established interaction patterns before creating new structures.
- Classify each significant element as `reuse`, `extend`, or `propose`:
  - `reuse`: insert the verified pinned component through the design-system component insertion workflow.
  - `extend`: preserve the existing component identity and report the missing state/property/slot that needs a reviewed design-system change.
  - `propose`: create only a clearly identified project-local visual proposal and report that it is not yet a published reusable component.
- Check information hierarchy, content clarity, empty/loading/error/success/disabled states, keyboard/focus behavior, contrast, touch targets, zoom/text growth, RTL/mixed-direction layout, localization expansion, theme parity, and relevant phone/tablet/desktop variants.
- Prototype all interactions needed to understand the requested flow; do not invent navigation or destructive behavior unsupported by the product specification.

## 4. Act as a senior software engineer

- Read active path-free repository inventories and implementation mappings when the Product has an authorized repository connection.
- Consider the target platform, existing source components/tokens/routes, data and permission boundaries, implementation complexity, asset/font availability, responsive constraints, and likely test impact.
- Prefer designs that can reuse mapped production components. Report mismatches between the design system and repository rather than hiding them with detached lookalikes.
- Never request arbitrary filesystem paths, secrets, shell execution through FormaSpec, remote URL fetching, raw HTML/CSS/JavaScript, or unsanitized SVG.

## 5. Inspect before publishing

- Inspect the returned PNG directly.
- Run structural linting and address all errors plus material warnings.
- Compare before/after for refinement and redesign tasks.
- Verify the preview targets the claimed task, Product, Design, base version, and intended pages/selection.
- Keep the task in `awaiting_approval`; never commit task-backed work.

## Required readiness report

Return this compact report before the preview links:

- **Product / Design:** exact names and opaque IDs, base version, pages/selection.
- **Product specification:** version/hash when available; affected roles, flows, rules, states, and acceptance criteria.
- **Design system:** effective system/release; components and tokens reused, extensions required, and project-local proposals.
- **Engineering context:** target platforms and repository inventories/mappings considered, or `not connected`.
- **Quality checks:** accessibility, RTL/localization, themes/states, responsive variants, prototype coverage, lint, and visual inspection.
- **Assumptions / blockers:** only bounded assumptions and unresolved decisions.
- **Approval:** exact inline PNG, task ID, expiry, `reviewDeepLink`, and `reviewLaunchLink` when supplied. State that no saved revision changes until a human commits the preview.
