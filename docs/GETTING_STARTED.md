# Getting started

FormaSpec is the browser product. **Minimal UI** is the name used when an
agent invokes FormaSpec through MCP.

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
6. Select **Start with Codex**, or invoke the agent from Codex directly.

## Use Minimal UI from Codex

The installer normally configures this automatically. To repair or repeat it:

```bash
./designer --yes agent connect codex
```

Then use:

```text
[@Minimal UI](plugin://minimal-ui@formaspec) design a professional mobile flow.
```

Other supported triggers include `Use FormaSpec`, `Use Minimal UI`, and
`Design this with FormaSpec`.

## Export and administer

The editor exports canonical JSON, PNG, and `.formaspec.zip`. Open
`/administration` to create/re-verify/download managed backups, validate a
portable bundle, then import it by preserving IDs or creating a deterministic
clone, and inspect/reconnect/revoke Codex connections. Portable mutation is an
Organization Administrator action and requires an idempotency key; the browser
generates one for the reviewed import.

Production readiness is still **NO-GO**. Read
[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) before server use.
