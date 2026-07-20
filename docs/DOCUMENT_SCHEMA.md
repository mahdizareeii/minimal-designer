# Document schema

## Version 1

`schema_version: 1` is permanently frozen. It stores projects, pages, frames,
nodes, tokens, assets, prototype links, and metadata with stable opaque IDs.
Historical V1 revisions remain immutable and exportable.

Supported V1 visual nodes are frame, group/container, component/template,
text, rectangle, ellipse, image, bundled icon, and detached instance data.
Documents reject arbitrary HTML, CSS, script, attributes, remote URLs, and
unsanitized SVG.

## Version 2

The strict V2 model adds semantic roles, locale/direction, typed token
references, versioned component definitions/instances, design-system pins,
product-specification links, and implementation mappings. Unknown externally
supplied fields are rejected.

The deterministic V1-to-V2 utility preserves project, page, node, token,
asset, and prototype IDs. Legacy free-form overrides and asset formats that
cannot enter the deterministic raster pipeline (for example GIF, font, video,
or binary records) retain their exact IDs and metadata as non-rendered
quarantine data with diagnostics. Only hashed, dimensioned PNG/JPEG/WebP image
assets may have V2 status `ready`.

Active-head migration is explicit, organization-admin-only, CAS/idempotency
protected, and backup-gated. It creates exactly one system-authored V2
migration revision while historical V1 revisions remain byte/hash immutable.
The strict compatibility corpus exercises every V1 node/token kind, prototype
action, RTL metadata, fractional geometry, component override, and legacy asset
class, including exact V2-to-V1 compatibility projection.

Portable bundles include bytes and SHA-256 records only for normalized assets.
Metadata-only legacy quarantine IDs are listed explicitly in the manifest so
export/import stays structurally lossless without treating unsafe bytes as
render-ready content. Manifests created before this additive field remain
readable as an empty quarantine list.

Import validation is read-only. Mutating import requires Organization
Administrator access and an idempotency key. Default `conflict_fail` mode keeps
project-scoped IDs and rejects any project/render-ready asset collision;
explicit `clone` mode deterministically remaps project-scoped IDs while leaving
arbitrary metadata text and external design-system/connection identifiers
untouched. Imported V1/V2 documents begin at local revision 1, and an imported
product specification begins at local version 1. V2 sidecar product-spec data
must exactly match the embedded specification. Raster bytes are decoded and
normalized through the isolated worker; unsupported legacy assets remain
metadata-only quarantine.

Migration 10 stores an immutable `portable_imports` provenance record containing
the bundle hash, source project/revision/hash claim, target project/revision,
canonical ID map, manifest, diagnostics, actor, and timestamp. The source
revision hash is a provenance claim from the bundle, not proof of a locally
verified source revision chain. The new local revision receives its own
snapshot and revision hashes.

Portable ZIP validation enforces 256 MiB compressed and aggregate-expanded
limits, 64 MiB per entry, and 20,000 entries. It validates central and local
headers, signed or signatureless descriptors, CRCs, flags, versions, regular
entry types, paths, duplicates, declared sizes, and complete DEFLATE
consumption before bounded 16 KiB per-entry inflation. Multipart bodies and
extracted entry buffers remain memory-resident within those caps; end-to-end
request streaming and broader stress evidence remain release requirements.

## Independent versions

Database schema, document schema, command engine, renderer, font bundle,
application build, and export format have separate metadata. A change to one
must not silently redefine another.
