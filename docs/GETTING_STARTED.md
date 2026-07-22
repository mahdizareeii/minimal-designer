# Getting started

FormaSpec is the browser product and primary agent identity.

> **Backward compatibility:** **Minimal UI** remains a legacy alias for
> existing prompts and integrations. Use FormaSpec for all new work. Both
> identities use the same token-free `formaspec` MCP connection.

## Install and start

From the repository root, choose one source installation:

```bash
./designer --yes install docker
```

```bash
./designer --yes install local
```

The installer checks the operating system and prerequisites, starts FormaSpec
and its loopback bridge, then offers to configure supported Codex after one
explicit authorization. For development:

```bash
pnpm dev
```

Open `http://127.0.0.1:4310` for the built application or
`http://127.0.0.1:4311` for Vite development.

## Create the first project

1. Select **Design a new product**.
2. Choose web, phone, or tablet.
3. In the editor, use the box labeled **Describe the product, business logic,
   and constraints**.
4. Save the typed product-specification preview.
5. Optionally complete the persistent 22-section planning interview.
6. Select **Submit to @FormaSpec**, or invoke FormaSpec from Codex directly.

## Use FormaSpec from Codex

The installer normally configures this automatically. To repair or repeat it:

```bash
./designer --yes agent connect codex
```

Then use:

```text
[@FormaSpec](plugin://formaspec@formaspec) design a professional mobile flow.
```

Other supported triggers include `Use FormaSpec`, `Design this with FormaSpec`,
and `Refine this selection with FormaSpec`.

> **Legacy prompt compatibility:** existing workflows may still use
> `Use Minimal UI` or
> `[@Minimal UI](plugin://minimal-ui@formaspec)`, but new workflows should not.

The primary FormaSpec plugin and its managed compatibility alias are version
0.2.0; start a new Codex task after installation or refresh.

When **Submit to @FormaSpec** creates a website task, Codex previews the design,
inspects the PNG, runs linting, and returns the task in
`awaiting_approval`. The product manager then commits or discards the exact
preview in FormaSpec. Codex must not commit or complete a website-created task.
A direct non-task Codex request may commit through MCP only after normal write
approval.

## Export and administer

The editor exports canonical JSON, PNG, and `.formaspec.zip`. Open
`/administration` to create/re-verify/download managed backups, validate a
portable bundle, then import it by preserving IDs or creating a deterministic
clone, and inspect/reconnect/revoke Codex connections. Portable mutation is an
Organization Administrator action and requires an idempotency key; the browser
generates one for the reviewed import.

Production readiness is still **NO-GO**. Read
[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) before server use.
