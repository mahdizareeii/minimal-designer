# Server deployment

Minimal Designer supports two server patterns:

- SSH-only mode for a small/private installation. The service remains on the
  server's loopback interface and is reached through an SSH tunnel.
- Trusted-proxy mode for an internal company URL. An HTTPS reverse proxy owns
  company authentication; Minimal Designer does not manage passwords in V1.

Docker Engine and Compose v2 are required on the server. Start with:

```bash
./designer doctor server
```

Runtime configuration and secrets are stored under `.designer/`, which is
ignored by Git and Docker builds.

## SSH-only server

This is the simplest safe server setup when you do not already have a trusted
SSO reverse proxy:

```bash
# Run on the server
./designer server init --ssh-only --port 4310
./designer start server
./designer status
```

The UI and MCP endpoint are not exposed on the server's network interfaces.
From each client computer, create a tunnel and keep it open:

```bash
ssh -L 4310:127.0.0.1:4310 user@your-server
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). Configure Codex on that
client with the output of `./designer codex-config local`, or use this equivalent
entry:

```toml
[mcp_servers.minimal_ui]
url = "http://127.0.0.1:4310/mcp"
required = true
default_tools_approval_mode = "writes"
tool_timeout_sec = 60
```

SSH-only mode has no application authentication because SSH and the loopback
binding are its security boundary. Do not publish port 4310 or change its bind
address to `0.0.0.0` in this mode.

## Trusted HTTPS/SSO proxy

Initialize a public-origin configuration and start the service:

```bash
./designer server init --public-url https://designer.company.example
./designer start server
```

The launcher generates a long MCP bearer token, stores the environment file
with mode `0600`, and still binds the application to `127.0.0.1`. To use a
different verified identity header, pass
`--identity-header X-Company-Identity` during `server init`.

The generated `.designer/env/server.env` has the following shape (the real
token is intentionally omitted):

```dotenv
BIND_ADDRESS=127.0.0.1
PUBLIC_BASE_URL=https://designer.company.example
AUTH_MODE=trusted-header
TRUSTED_USER_HEADER=x-designer-user
DESIGNER_TOKEN=replace-with-a-long-random-secret
```

`DESIGNER_TOKEN` is mandatory in `trusted-header` mode and protects `/mcp` with
bearer authentication. The browser UI instead trusts only the identity header
set by the proxy. Never expose the application port directly, because a client
that can bypass the proxy could forge that header.

## Reverse proxy requirements

- Terminate TLS and restrict the site to company users.
- Remove any client-provided `X-Designer-User`, then set it from the verified SSO
  identity for browser and REST requests.
- Forward the `Authorization` header unchanged so `/mcp` can validate its bearer
  token.
- Disable response buffering for `/api/events` so SSE updates arrive promptly.
- Preserve the original host and scheme used by `PUBLIC_BASE_URL`.
- Restrict direct access to `127.0.0.1:4310` to the proxy host and local
  administrators.

Illustrative Nginx location after the authentication layer has populated
`$remote_user`:

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Designer-User $remote_user;
    proxy_set_header Authorization $http_authorization;
}

location /api/events {
    proxy_pass http://127.0.0.1:4310;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Designer-User $remote_user;
    proxy_buffering off;
    proxy_cache off;
}
```

The authentication layer and `$remote_user` setup are company-specific; do not
use the example without verified upstream identity.

## Codex with the trusted proxy

On the server, print the generated configuration and token separately:

```bash
./designer codex-config server
./designer token
```

Copy the TOML to the Codex computer, then set `MINIMAL_UI_MCP_TOKEN` on that
computer to the token value. The resulting configuration is:

```toml
[mcp_servers.minimal_ui]
url = "https://designer.company.example/mcp"
required = true
bearer_token_env_var = "MINIMAL_UI_MCP_TOKEN"
default_tools_approval_mode = "writes"
tool_timeout_sec = 60
```

Do not put the token directly in TOML or commit it to either repository. Restart
Codex after changing MCP configuration or its environment.

## Operations

```bash
./designer status
./designer logs
./designer logs --follow
./designer restart
./designer stop
```

`stop` removes containers while preserving the Docker data volume. Use
`./designer start server --no-build` when the existing image is already current.

## Backups

Create a consistent backup with:

```bash
./designer backup /safe/path/designer-backup
```

The launcher stops the designer container, copies all of `/data`, and starts it
again. Restore the database, WAL files, and assets together into an empty volume
while the service is stopped. Then verify `/ready`, revision history, PNG
rendering, and an uploaded asset before allowing writes.

Keep server backups and `.designer/env/server.env` access-controlled. They may
contain private designs, uploaded assets, identity metadata, and the MCP secret.
