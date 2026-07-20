# Design system

FormaSpec ships the modeled **FormaSpec Foundation System**.

It includes primitive, semantic, and component token layers; light, dark, and
high-contrast contexts; LTR, RTL, and mixed-direction defaults; deterministic
Inter and Vazirmatn fonts; and permissively licensed bundled icons.

Token families include color, spacing, dimension, radius, border width,
opacity, typography, shadow, font properties, number, string, and duration.
Aliases are typed, family-compatible, bounded, and cycle-checked.

The core component catalog models buttons, inputs, selections, navigation,
cards, alerts, tables, dialogs, states, and application-shell patterns through
typed contracts, bounded properties/slots/states, lifecycle status, release
pins, replacement links, and platform mappings.

FormaSpec can export bounded token value files for CSS, TypeScript, Android
XML, Jetpack Compose, Swift, and Flutter. These exports are values for a real
application theme, not generated applications.

Migration 8 now persists organization design systems, append-only token and
component versions, immutable release envelopes, exact project pins, and
expiring upgrade previews. The server validates lifecycle state, aliases,
replacement links, duplicate paths, selected entity versions, design/revision
binding, preview hashes, expiry, and stale pins. REST and MCP expose bounded
read/preview/commit workflows. Administration can create/list organization
systems and now provides a typed component-contract editor for properties,
slots, states, documentation, and bounded overrides. Component saves append a
draft version; publish and deprecate actions clone the exact latest definition
into another immutable version. Organization Administrators and Design Editors
may author components, while organization/project isolation remains enforced.

`GET /api/design-systems/:designSystemId/components` lists the latest component
definitions and lifecycle/replacement diagnostics; `includeHistory=true`
returns immutable history. The same response includes the server-derived
`permissions.canAuthorComponents` capability. Administration uses that value
instead of guessing from failed Administrator-only requests: Product Managers,
Engineers, and Viewers receive a read-only catalog without mutation controls.
Lifecycle transitions use
`POST /api/design-systems/:designSystemId/components/:componentId/lifecycle`
with an expected latest version, so stale operations fail rather than overwrite
another editor's work.

The remaining product work is token/release authoring, richer component
documentation and platform-mapping editors, project pin/upgrade review in the
editor, visual migration comparison, policy-configurable delegated roles, and
synchronization of a persisted pin with a future V2 document-head migration
revision.
