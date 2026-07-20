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

Do not expose current source builds as enterprise production services. The
required renderer isolation, deployment/security suites, signed packages, and
release evidence remain incomplete.
