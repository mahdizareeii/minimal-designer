# Historical database fixtures

`historical-database.ts` builds historical SQLite databases from the same
ordered migration functions used at application startup. It never creates a
current database and then drops tables to imitate an older version.

The fixture corpus covers:

- schema 1: two immutable V1 revisions and one legacy image BLOB;
- schemas 7 through 10: the same V1 history after each genuine migration
  prefix, with organization ownership and linked product-specification data;
- schema 11: the V1 history plus design-system, release/pin, repository
  inventory, implementation mapping, handoff, and queued render-job rows.

Stable schema fingerprints, revision hashes, asset SHA-256, and a schema-11
row-set fingerprint are checked in as reviewed evidence. If an old migration
or fixture payload changes, tests fail until the historical change is
explicitly investigated. The fixtures are source-built and contain no opaque
SQLite binaries.
