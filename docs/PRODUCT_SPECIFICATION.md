# Product specification

The editor contains the exact prompt surface:

> Describe the product, business logic, and constraints

The website persists both the natural-language brief and a strict structured
specification. Typed collections cover goals, non-goals, audiences, roles,
entities, flows, business rules, permissions, validation, screen states,
integrations, analytics, accessibility, non-functional requirements,
acceptance criteria, assumptions, and open questions. Items use stable IDs and
may link to design entities.

Specification changes use preview then commit. A preview is exact, versioned,
expiring, linted, and does not mutate the committed specification. Commits use
the expected base version and idempotency key.

The guided product-manager interview persists 22 focused sections, is
resumable/editable/versioned, and remains canonical on the website. MCP
elicitation is optional.

FormaSpec represents conditions, permissions, states, validation,
transitions, outcomes, and acceptance criteria as data; it does not execute
production business logic.
