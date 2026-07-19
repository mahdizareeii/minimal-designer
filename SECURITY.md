# Security

Minimal Designer is intended for private company deployments. Do not expose a
development instance with `AUTH_MODE=none` to an untrusted network.

## Production baseline

- Terminate HTTPS at a trusted reverse proxy.
- Use `AUTH_MODE=trusted-header` for the browser UI and configure the proxy to
  remove any client-supplied identity header before adding its verified value.
- Set a strong `DESIGNER_TOKEN` for the MCP endpoint and provide it to Codex
  through `bearer_token_env_var`.
- Keep the published Docker port on `127.0.0.1` unless a trusted HTTPS reverse
  proxy is the only reachable ingress. Never publish `AUTH_MODE=none` publicly.
- Restrict inbound access to company users and back up the complete data volume.
- Keep the container and dependencies updated after testing upgrades in a copy
  of the deployment.

## Application boundaries

- MCP tools do not expose shell commands, arbitrary file paths, or URL fetching.
- Design text and metadata are treated as untrusted content, not instructions.
- Writes use expected versions and idempotency keys; conflicts never auto-merge.
- Uploaded assets are byte- and pixel-limited and must be PNG, JPEG, or WebP.
- SVG upload is intentionally disabled in V1.
- Rendered HTML/CSS must not interpolate untrusted URLs or raw declarations.

## Reporting

Report suspected vulnerabilities privately to the repository owner with the
affected version, deployment mode, reproduction steps, and potential impact.
Avoid attaching company designs, tokens, or database files unless a secure
channel has been agreed.
