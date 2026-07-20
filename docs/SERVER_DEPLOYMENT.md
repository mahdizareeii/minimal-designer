# Server deployment

The detailed deployment guide is [deployment.md](./deployment.md). This file
records the required public contract.

Server mode is fail-closed and requires:

```dotenv
APP_MODE=server
HOST=0.0.0.0
PUBLIC_BASE_URL=https://design.example.com
AUTH_MODE=trusted-header
DESIGNER_TOKEN=replace-with-a-long-bootstrap-token
TRUSTED_USER_HEADER=x-designer-user
FORMASPEC_ALLOWED_HOSTS=design.example.com
FORMASPEC_TRUSTED_PROXIES=127.0.0.1,::1,172.16.0.0/12
DESIGNER_CORS_ORIGINS=https://design.example.com
FORMASPEC_CONTAINER_LOCAL=false
```

The reverse proxy must terminate HTTPS, remove caller-supplied identity and
forwarding headers, inject one canonical identity header, preserve the public
origin, and prevent direct public access to the application port. Browser
writes require the configured Origin and `x-formaspec-csrf: 1` intent header.

Generate source-mode server configuration with:

```bash
./designer server init --public-url https://design.example.com
```

Starting through the current `formaspecctl`/`designer` wrapper records a
mode-`0600`, secret-free runtime binding for the fixed Compose project. An
Organization Administrator can then select an exact managed backup ID from the
Administration UI and run the external maintenance workflow on the server host:

```bash
./designer --yes backup restore --backup-id backup_<40-lowercase-hex>
./designer backup restore status
./designer --yes backup restore resume
./designer --yes backup restore rollback
```

The supervisor revalidates the secure server environment hash, public Host,
loopback port, Docker context/daemon, image, container labels, and named volumes
before each action. It never serializes or passes `DESIGNER_TOKEN` to the
network-disabled restore worker. Unknown/custom Compose projects, bind mounts,
Kubernetes/Swarm, and off-host volumes are outside this supported boundary.

Do not expose current source builds as enterprise production services. The
required clean server restore/rollback exercise, deployment/security suites,
signed packages, alerting, and release evidence remain incomplete.
