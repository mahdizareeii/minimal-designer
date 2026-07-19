# Minimal Designer

A self-hosted, AI-first UI designer for product teams. Product managers describe
screens to Codex; Codex creates a validated preview through MCP, inspects the
rendered result, and commits it to the same document that people edit in the
browser.

The project is intentionally smaller than Figma: it focuses on structured web,
phone, and tablet UI, design tokens, editable handoff, simple prototype links,
and immutable history. It does not require an OpenAI API key and has no hosted
designer dependency. Your existing Codex access is separate.

## Easiest first run

Run the launcher from the project directory:

```bash
./designer
```

It detects macOS, Linux, or WSL; checks ports and requirements; and guides you
through local Docker, native development, or server setup. Docker local mode is
recommended because it includes Node, Chromium, and all native dependencies.
On macOS, the launcher can also offer to start Docker Desktop when it is
installed but its engine is stopped.

For a non-interactive diagnosis and Docker start:

```bash
./designer doctor auto
./designer start docker
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). The launcher keeps generated
configuration, process state, logs, backups, and server secrets under the
ignored `.designer/` directory. Project data is persisted in the
`designer-data` Docker volume.

Use `./designer --dry-run start docker` to inspect a startup plan without
installing packages, writing runtime files, or starting a process/container.

## Local Docker

Requirements: Docker Desktop, or Docker Engine with Compose v2. Make sure the
Docker engine is running, then use:

```bash
./designer setup docker
./designer start docker
```

The setup command only checks Docker and Compose. `start docker` builds the
single application image, binds it to loopback, waits for readiness, and opens
the editor. Useful variants are:

```bash
./designer start docker --port 4410 --no-open
./designer start docker --no-build
```

Keep the default loopback binding while `AUTH_MODE=none`. To run Compose
directly instead of using the launcher:

```bash
docker compose up --build
```

## Native development and local production

Requirements: Node.js 24+, pnpm 11+, and a Chromium browser for server-side PNG
rendering. The launcher can prepare dependencies, build bundled fonts, verify
SQLite, and optionally install Playwright Chromium:

```bash
./designer doctor local
./designer setup local
./designer dev
```

Development mode runs until Ctrl+C:

- Editor: [http://127.0.0.1:4311](http://127.0.0.1:4311)
- API and MCP: [http://127.0.0.1:4310](http://127.0.0.1:4310)

After the first setup, use `./designer dev --skip-setup` for a faster restart.
To run the built application in the background instead, use:

```bash
./designer start local
```

The renderer automatically tries an installed Google Chrome/Chromium. Docker
already contains the matching Playwright browser.

## Server deployment

The launcher supports two safe server configurations. Both keep the application
port bound to `127.0.0.1` on the server.

For a private server reached only through SSH:

```bash
# On the server
./designer server init --ssh-only
./designer start server

# On your computer
ssh -L 4310:127.0.0.1:4310 user@your-server
```

Keep that SSH session open, then use
[http://127.0.0.1:4310](http://127.0.0.1:4310) in the browser and in the local
Codex MCP configuration.

For an internal company URL behind an existing HTTPS/SSO reverse proxy:

```bash
./designer server init --public-url https://designer.company.example
./designer start server
```

This generates a protected MCP bearer token and configures trusted-header UI
authentication. The proxy must authenticate users, remove any client-supplied
identity header, set the verified identity header itself, forward bearer
authorization to `/mcp`, and disable buffering for SSE. See
[`docs/deployment.md`](docs/deployment.md) before exposing the service.

## Operations

The same commands work for native, Docker, and server modes where applicable:

```bash
./designer status
./designer logs
./designer logs --follow
./designer open
./designer restart
./designer stop
./designer backup /safe/path/designer-backup
```

`stop` preserves persistent design data. A backup includes SQLite/WAL state and
assets; the launcher briefly stops a Docker service while copying a consistent
snapshot.

## Connect Codex through MCP

Print the correct local configuration with:

```bash
./designer codex-config local
```

Copy its output into the trusted project's `.codex/config.toml` or the global
`~/.codex/config.toml`, then restart Codex. The generated local configuration is
equivalent to:

```toml
[mcp_servers.minimal_ui]
url = "http://127.0.0.1:4310/mcp"
required = true
default_tools_approval_mode = "writes"
tool_timeout_sec = 60
```

SSH-only deployments use this same local configuration while the tunnel is
open. For a trusted-proxy deployment, run these commands on the server:

```bash
./designer codex-config server
./designer token
```

Copy the first command's TOML to the Codex computer and set
`MINIMAL_UI_MCP_TOKEN` there to the second command's value. Treat that output as
a secret: do not paste it into TOML, logs, shell scripts, or source control.
The server configuration uses `bearer_token_env_var = "MINIMAL_UI_MCP_TOKEN"`.

The intended Codex workflow is:

1. Read the active context or select a design explicitly.
2. Build a complete change with `design_preview_changes`. Existing entities use
   permanent IDs; new entities may use transaction-local IDs such as `tmp:header`.
3. Inspect the returned PNG and lint diagnostics.
4. Commit the exact preview with `design_commit_preview`.
5. Open the returned deep link for human review. On `VERSION_CONFLICT`, read the
   new head and create a new preview.

The application itself does not need an OpenAI API key.

## Development verification

Run the launcher checks and workspace verification with:

```bash
pnpm test:launcher
pnpm typecheck
pnpm test:run
pnpm build
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Docker overrides it to `0.0.0.0`. |
| `PORT` | `4310` | HTTP port. |
| `BIND_ADDRESS` | `127.0.0.1` | Docker host interface. Do not use `0.0.0.0` with `AUTH_MODE=none`. |
| `DATA_DIR` | `./data` | SQLite, assets, and render storage. |
| `PUBLIC_BASE_URL` | local API URL | Deep-link and render URL base. |
| `AUTH_MODE` | `none` | Use `none` on loopback or `trusted-header` behind the company proxy. `token` is intended for headless API access, not the browser UI. |
| `DESIGNER_TOKEN` | empty | Required bearer token in `token` and `trusted-header` modes; MCP always uses it in server mode. |
| `TRUSTED_USER_HEADER` | `x-designer-user` | Identity header set by a trusted proxy. |
| `MAX_UPLOAD_BYTES` | `5242880` | Maximum asset upload size. |
| `DESIGNER_API_URL` | `http://127.0.0.1:4310` | API URL used by the Vite development editor. |
| `DESIGNER_WEB_HOST` | `127.0.0.1` | Vite development bind address. |
| `DESIGNER_WEB_PORT` | `4311` | Vite development port. |

## Manual backup and restore

Prefer `./designer backup [DESTINATION]`. If you started the application with
plain `docker compose up` instead of the launcher, SQLite uses WAL, so stop the
application container before a manual filesystem copy:

```bash
docker compose stop designer
mkdir -p backups/designer-data
docker compose cp designer:/data/. backups/designer-data/
docker compose start designer
```

Restore into an empty replacement data volume while the container is stopped,
copy the complete directory back to `/data`, then start the service. Verify
`/ready`, open revision history, and fetch at least one uploaded asset before
reopening writes. The database, WAL files, asset BLOBs, and immutable revisions
must always be backed up and restored together.

## V1 boundaries

The V1 document uses fixed-size frames with absolute, row, column, and simple
grid layouts. It includes deterministic Latin and RTL text behavior. Realtime
multiplayer, arbitrary vector paths, linked component variants, Figma import,
animation, production-code generation, and plugins are intentionally deferred.

See [`docs/architecture.md`](docs/architecture.md) for the internal model.
For a secured company deployment, follow
[`docs/deployment.md`](docs/deployment.md).
