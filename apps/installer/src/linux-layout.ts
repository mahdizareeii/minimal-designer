export const LINUX_INSTALL_ROOT = "/opt/formaspec";
export const LINUX_STATE_ROOT = "/var/lib/formaspec";
export const LINUX_RENDERER_STATE_ROOT = "/var/cache/formaspec-renderer";
export const LINUX_RUNTIME_ROOT = "/run/formaspec";
export const LINUX_CONFIG_ROOT = "/etc/formaspec";
export const LINUX_SERVICE_USER = "formaspec";
export const LINUX_API_SERVICE = "formaspec-api.service";
export const LINUX_RENDERER_SERVICE = "formaspec-renderer.service";

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface RpmVersion {
  version: string;
  release: string;
}

export function assertLinuxPackageVersion(value: string): string {
  if (!SEMANTIC_VERSION.test(value)) {
    throw new Error("Linux installer version must be a semantic version without whitespace or shell metacharacters.");
  }
  return value;
}

export function rpmVersion(value: string): RpmVersion {
  const match = SEMANTIC_VERSION.exec(assertLinuxPackageVersion(value));
  if (!match) throw new Error("Linux installer version is invalid.");
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  const safe = (part: string): string => part.replaceAll("-", "_");
  const prerelease = match[4];
  const build = match[5];
  const release = prerelease === undefined
    ? `1${build === undefined ? "" : `.${safe(build)}`}`
    : `0.${safe(prerelease)}${build === undefined ? "" : `.${safe(build)}`}`;
  return { version: base, release };
}

export function linuxPackageArchitecture(
  architecture: string,
  format: "deb" | "rpm",
): string {
  if (architecture === "x64") return format === "deb" ? "amd64" : "x86_64";
  if (architecture === "arm64") return format === "deb" ? "arm64" : "aarch64";
  throw new Error(`Unsupported Linux installer architecture: ${architecture}`);
}

function rendererServicePreamble(): string {
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${LINUX_INSTALL_ROOT}'
RENDERER_HOME='${LINUX_RENDERER_STATE_ROOT}'
RUNTIME_ROOT='${LINUX_RUNTIME_ROOT}'
if [ "$(id -u)" -eq 0 ]; then
  echo 'FormaSpec services must run as the unprivileged formaspec account.' >&2
  exit 1
fi
umask 077
mkdir -p "\${RENDERER_HOME}" "\${RUNTIME_ROOT}"
export HOME="\${RENDERER_HOME}"
export PATH="\${INSTALL_ROOT}/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="\${INSTALL_ROOT}/runtime/ms-playwright"
export NODE_ENV=production
export LANG=C.UTF-8
export TZ=UTC
`;
}

function apiServicePreamble(): string {
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${LINUX_INSTALL_ROOT}'
STATE_ROOT='${LINUX_STATE_ROOT}'
RUNTIME_ROOT='${LINUX_RUNTIME_ROOT}'
if [ "$(id -u)" -eq 0 ]; then
  echo 'FormaSpec services must run as the unprivileged formaspec account.' >&2
  exit 1
fi
umask 077
mkdir -p "\${STATE_ROOT}/data" "\${STATE_ROOT}/backups" "\${RUNTIME_ROOT}"
export HOME="\${STATE_ROOT}"
export PATH="\${INSTALL_ROOT}/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="\${INSTALL_ROOT}/runtime/ms-playwright"
export NODE_ENV=production
export LANG=C.UTF-8
export TZ=UTC
`;
}

export function linuxRendererWrapper(): string {
  return `${rendererServicePreamble()}export FORMASPEC_RENDER_SOCKET="\${RUNTIME_ROOT}/renderer.sock"
export FORMASPEC_RENDER_TIMEOUT_MS=15000
export FORMASPEC_RENDER_MAX_PIXELS=32000000
export DESIGNER_MAX_ASSET_PIXELS=32000000
export MAX_UPLOAD_BYTES=5242880
export FORMASPEC_RENDER_CONCURRENCY="\${FORMASPEC_RENDER_CONCURRENCY:-2}"
export FORMASPEC_RENDER_QUEUE_LIMIT="\${FORMASPEC_RENDER_QUEUE_LIMIT:-32}"
export FORMASPEC_RENDER_IPC_MAX_BYTES=100663296
export FORMASPEC_ALLOW_SYSTEM_CHROME=false
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/server/dist/renderer-worker.js"
`;
}

export function linuxApiWrapper(): string {
  return `${apiServicePreamble()}export APP_MODE=local
export HOST=127.0.0.1
export PORT=4310
export DATA_DIR="\${STATE_ROOT}/data"
export BACKUP_DIR="\${STATE_ROOT}/backups"
export PUBLIC_BASE_URL=http://127.0.0.1:4310
export AUTH_MODE=none
export FORMASPEC_RENDER_SOCKET="\${RUNTIME_ROOT}/renderer.sock"
export FORMASPEC_RENDER_TIMEOUT_MS=15000
export FORMASPEC_RENDER_MAX_PIXELS=32000000
export DESIGNER_MAX_ASSET_PIXELS=32000000
export MAX_UPLOAD_BYTES=5242880
export FORMASPEC_RENDER_IPC_MAX_BYTES=100663296
export FORMASPEC_ALLOW_SYSTEM_CHROME=false
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/server/dist/index.js"
`;
}

function userRuntimePreamble(): string {
  return `INSTALL_ROOT='${LINUX_INSTALL_ROOT}'
SYSTEM_STATE_ROOT='${LINUX_STATE_ROOT}'
if [ -n "\${FORMASPEC_RUNTIME_DIR:-}" ]; then
  RUNTIME_ROOT="\${FORMASPEC_RUNTIME_DIR}"
elif [ -n "\${XDG_STATE_HOME:-}" ]; then
  case "\${XDG_STATE_HOME}" in /*) RUNTIME_ROOT="\${XDG_STATE_HOME}/formaspec" ;; *) echo 'XDG_STATE_HOME must be absolute.' >&2; exit 2 ;; esac
else
  [ -n "\${HOME:-}" ] || { echo 'HOME is required for per-user FormaSpec state.' >&2; exit 2; }
  RUNTIME_ROOT="\${HOME}/.local/state/formaspec"
fi
case "\${RUNTIME_ROOT}" in /*) ;; *) echo 'FORMASPEC_RUNTIME_DIR must be absolute.' >&2; exit 2 ;; esac
export FORMASPEC_RUNTIME_DIR="\${RUNTIME_ROOT}"
export FORMASPEC_DATA_DIR="\${FORMASPEC_DATA_DIR:-\${SYSTEM_STATE_ROOT}/data}"
export FORMASPEC_BACKUP_DIR="\${FORMASPEC_BACKUP_DIR:-\${SYSTEM_STATE_ROOT}/backups}"
export FORMASPEC_LOG_DIR="\${FORMASPEC_LOG_DIR:-\${RUNTIME_ROOT}/logs}"
export FORMASPEC_SUPPORT_DIR="\${FORMASPEC_SUPPORT_DIR:-\${RUNTIME_ROOT}/support-bundles}"
export PATH="\${INSTALL_ROOT}/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\${PATH:-}"
export PLAYWRIGHT_BROWSERS_PATH="\${INSTALL_ROOT}/runtime/ms-playwright"
`;
}

export function linuxFormaspecctlWrapper(): string {
  return `#!/bin/sh
set -eu
${userRuntimePreamble()}mkdir -p "\${RUNTIME_ROOT}/run" "\${RUNTIME_ROOT}/logs"
chmod 700 "\${RUNTIME_ROOT}" "\${RUNTIME_ROOT}/run" "\${RUNTIME_ROOT}/logs"
if [ "\${1:-}" = install ] && [ "$#" -eq 1 ]; then set -- install local; fi
if [ "\${1:-}" = start ] && [ "$#" -eq 1 ]; then set -- start local; fi
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/cli/dist/index.js" "$@"
`;
}

export function linuxCompatibilityLauncher(version: string): string {
  assertLinuxPackageVersion(version);
  return `#!/bin/sh
set -eu
${userRuntimePreamble()}NO_OPEN=0
while [ "\${1:-}" = "--yes" ] || [ "\${1:-}" = "--no-open" ]; do
  if [ "$1" = "--no-open" ]; then NO_OPEN=1; fi
  shift
done
COMMAND="\${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
require_systemd() {
  [ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ] || {
    echo 'The native Linux package requires a running systemd system instance.' >&2
    exit 1
  }
}
record_state() {
  mkdir -p "\${RUNTIME_ROOT}/run"
  chmod 700 "\${RUNTIME_ROOT}" "\${RUNTIME_ROOT}/run"
  printf 'local\n' >"\${RUNTIME_ROOT}/run/mode"
  printf '4310\n' >"\${RUNTIME_ROOT}/run/api-port"
  printf 'http://127.0.0.1:4310\n' >"\${RUNTIME_ROOT}/run/url"
  chmod 600 "\${RUNTIME_ROOT}/run/mode" "\${RUNTIME_ROOT}/run/api-port" "\${RUNTIME_ROOT}/run/url"
}
health_ready() {
  "\${INSTALL_ROOT}/runtime/node" -e 'fetch("http://127.0.0.1:4310/health/ready", {signal: AbortSignal.timeout(750)}).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))'
}
open_browser() {
  if [ "\${NO_OPEN}" -eq 1 ] || [ "$(id -u)" -eq 0 ]; then return 0; fi
  if [ -z "\${DISPLAY:-}" ] && [ -z "\${WAYLAND_DISPLAY:-}" ]; then return 0; fi
  if [ -x /usr/bin/xdg-open ]; then /usr/bin/xdg-open http://127.0.0.1:4310 >/dev/null 2>&1 & fi
}
start_services() {
  require_systemd
  /usr/bin/systemctl start '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
  record_state
  ATTEMPT=0
  while [ "\${ATTEMPT}" -lt 80 ]; do
    if health_ready; then open_browser; return 0; fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 0.1
  done
  echo 'FormaSpec did not become ready. Inspect systemctl status and journalctl for the FormaSpec services.' >&2
  return 1
}
case "\${COMMAND}" in
  help|-h|--help)
    echo 'Packaged FormaSpec launcher: setup local | start local | stop | restart | status | doctor local | logs | version'
    ;;
  version|--version) echo 'FormaSpec ${version}' ;;
  setup)
    [ "\${1:-local}" = local ] || { echo 'The Linux package supports the bundled local runtime only.' >&2; exit 2; }
    require_systemd
    [ -x "\${INSTALL_ROOT}/runtime/node" ]
    [ -f "\${INSTALL_ROOT}/app/apps/server/dist/index.js" ]
    [ -f "\${INSTALL_ROOT}/app/apps/server/dist/renderer-worker.js" ]
    [ -d "\${INSTALL_ROOT}/runtime/ms-playwright" ]
    ;;
  start)
    [ "\${1:-local}" = local ] || { echo 'The Linux package supports the bundled local runtime only.' >&2; exit 2; }
    start_services
    ;;
  stop)
    require_systemd
    /usr/bin/systemctl stop '${LINUX_API_SERVICE}' '${LINUX_RENDERER_SERVICE}'
    ;;
  restart)
    require_systemd
    /usr/bin/systemctl restart '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
    record_state
    ;;
  status)
    require_systemd
    /usr/bin/systemctl --no-pager --full status '${LINUX_API_SERVICE}' '${LINUX_RENDERER_SERVICE}'
    health_ready
    ;;
  doctor)
    [ "\${1:-local}" = local ] || [ "\${1:-auto}" = auto ] || { echo 'Use doctor local or doctor auto.' >&2; exit 2; }
    "$0" setup local
    health_ready
    ;;
  logs)
    require_systemd
    exec /usr/bin/journalctl --no-pager -n 200 -u '${LINUX_API_SERVICE}' -u '${LINUX_RENDERER_SERVICE}'
    ;;
  *) echo "Unsupported packaged launcher command: \${COMMAND}" >&2; exit 2 ;;
esac
`;
}

function hardeningDirectives(kind: "api" | "renderer"): string {
  const addressPolicy = kind === "renderer"
    ? "RestrictAddressFamilies=AF_UNIX\nIPAddressDeny=any"
    : "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nIPAddressDeny=any\nIPAddressAllow=localhost";
  const inaccessiblePaths = kind === "renderer" ? `\nInaccessiblePaths=-${LINUX_STATE_ROOT}` : "";
  const writablePaths = kind === "renderer"
    ? `${LINUX_RENDERER_STATE_ROOT} ${LINUX_RUNTIME_ROOT}`
    : `${LINUX_STATE_ROOT} ${LINUX_RUNTIME_ROOT}`;
  return `NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectHostname=true
ProtectClock=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectProc=invisible
ProcSubset=pid
RestrictRealtime=true
RestrictSUIDSGID=true
RemoveIPC=true
${addressPolicy}
${inaccessiblePaths}
ReadWritePaths=${writablePaths}
UMask=0077
TasksMax=256
LimitNOFILE=65536
TimeoutStopSec=30s`;
}

export function linuxRendererServiceUnit(): string {
  return `[Unit]
Description=FormaSpec isolated renderer
Documentation=file:///usr/share/doc/formaspec/LINUX_PACKAGING.md
After=local-fs.target

[Service]
Type=simple
User=${LINUX_SERVICE_USER}
Group=${LINUX_SERVICE_USER}
EnvironmentFile=-${LINUX_CONFIG_ROOT}/formaspec.env
ExecStart=${LINUX_INSTALL_ROOT}/bin/formaspec-renderer
Restart=on-failure
RestartSec=2s
RuntimeDirectory=formaspec
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
CacheDirectory=formaspec-renderer
CacheDirectoryMode=0750
MemoryMax=1536M
${hardeningDirectives("renderer")}

[Install]
WantedBy=multi-user.target
`;
}

export function linuxApiServiceUnit(): string {
  return `[Unit]
Description=FormaSpec loopback API and editor
Documentation=file:///usr/share/doc/formaspec/LINUX_PACKAGING.md
Requires=${LINUX_RENDERER_SERVICE}
After=local-fs.target ${LINUX_RENDERER_SERVICE}

[Service]
Type=simple
User=${LINUX_SERVICE_USER}
Group=${LINUX_SERVICE_USER}
EnvironmentFile=-${LINUX_CONFIG_ROOT}/formaspec.env
ExecStart=${LINUX_INSTALL_ROOT}/bin/formaspec-api
Restart=on-failure
RestartSec=2s
RuntimeDirectory=formaspec
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
StateDirectory=formaspec
StateDirectoryMode=0750
MemoryMax=768M
${hardeningDirectives("api")}

[Install]
WantedBy=multi-user.target
`;
}

export function linuxEnvironmentFile(): string {
  return `# FormaSpec native Linux operational limits. This file intentionally contains no credentials.
FORMASPEC_RENDER_CONCURRENCY=2
FORMASPEC_RENDER_QUEUE_LIMIT=32
`;
}

export function linuxUrlHandler(): string {
  return `#!/bin/sh
set -eu
URL="\${1:-}"
case "\${URL}" in
  ''|formaspec://|formaspec://open) TARGET='http://127.0.0.1:4310' ;;
  formaspec://connect-agent) TARGET='http://127.0.0.1:4310/administration' ;;
  *) echo 'Unsupported or malformed FormaSpec URL.' >&2; exit 2 ;;
esac
[ -x /usr/bin/xdg-open ] || { echo 'xdg-open is required to open FormaSpec.' >&2; exit 1; }
exec /usr/bin/xdg-open "\${TARGET}"
`;
}

export function linuxDesktopEntry(): string {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=FormaSpec
Comment=AI-first structured UI design workspace
Exec=/usr/bin/formaspec-open %u
TryExec=/usr/bin/formaspec-open
Terminal=false
StartupNotify=true
Categories=Development;Graphics;
MimeType=x-scheme-handler/formaspec;
`;
}

export function linuxAppStreamMetadata(version: string): string {
  assertLinuxPackageVersion(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>com.formaspec.FormaSpec</id>
  <name>FormaSpec</name>
  <summary>AI-first structured UI design workspace</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>LicenseRef-FormaSpec-Internal</project_license>
  <launchable type="desktop-id">formaspec.desktop</launchable>
  <provides><binary>formaspecctl</binary></provides>
  <releases><release version="${version}"/></releases>
</component>
`;
}

function managedInstallChecks(): string {
  return `if [ -e '${LINUX_INSTALL_ROOT}' ] && [ ! -f '${LINUX_INSTALL_ROOT}/install-manifest.json' ]; then
  echo 'Refusing to replace an unmanaged ${LINUX_INSTALL_ROOT} directory.' >&2
  exit 1
fi
if [ -e /usr/bin/formaspecctl ] && ! grep -Fq "INSTALL_ROOT='${LINUX_INSTALL_ROOT}'" /usr/bin/formaspecctl; then
  echo 'Refusing to replace an unmanaged /usr/bin/formaspecctl.' >&2
  exit 1
fi
if [ -e /usr/bin/designer ] && ! grep -Fq "INSTALL_ROOT='${LINUX_INSTALL_ROOT}'" /usr/bin/designer; then
  echo 'Refusing to replace an unmanaged /usr/bin/designer.' >&2
  exit 1
fi
`;
}

function systemUserSetup(): string {
  return `for TOOL in getent groupadd useradd; do command -v "\${TOOL}" >/dev/null 2>&1 || { echo "Required account tool is unavailable: \${TOOL}" >&2; exit 1; }; done
NOLOGIN="$(command -v nologin 2>/dev/null || true)"
[ -n "\${NOLOGIN}" ] || { echo 'A nologin executable is required for the FormaSpec service account.' >&2; exit 1; }
if ! getent group '${LINUX_SERVICE_USER}' >/dev/null 2>&1; then groupadd --system '${LINUX_SERVICE_USER}'; fi
if getent passwd '${LINUX_SERVICE_USER}' >/dev/null 2>&1; then
  ENTRY="$(getent passwd '${LINUX_SERVICE_USER}')"
  USER_ID="$(echo "\${ENTRY}" | cut -d: -f3)"
  USER_HOME="$(echo "\${ENTRY}" | cut -d: -f6)"
  USER_SHELL="$(echo "\${ENTRY}" | cut -d: -f7)"
  case "\${USER_SHELL}" in */nologin|*/false) SAFE_SHELL=1 ;; *) SAFE_SHELL=0 ;; esac
  [ "\${USER_ID}" != 0 ] && [ "\${USER_HOME}" = '${LINUX_STATE_ROOT}' ] && [ "\${SAFE_SHELL}" -eq 1 ] || {
    echo 'Existing formaspec account is incompatible with the managed service account.' >&2
    exit 1
  }
else
  useradd --system --gid '${LINUX_SERVICE_USER}' --home-dir '${LINUX_STATE_ROOT}' --shell "\${NOLOGIN}" '${LINUX_SERVICE_USER}'
fi
`;
}

export function linuxDebPreInstallScript(): string {
  return `#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'FormaSpec package installation must run as root.' >&2; exit 1; }
${managedInstallChecks()}${systemUserSetup()}exit 0
`;
}

export function linuxDebPostInstallScript(): string {
  return `#!/bin/sh
set -eu
[ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ] || { echo 'FormaSpec requires a running systemd system instance.' >&2; exit 1; }
install -d -m 0750 -o '${LINUX_SERVICE_USER}' -g '${LINUX_SERVICE_USER}' '${LINUX_STATE_ROOT}' '${LINUX_STATE_ROOT}/data' '${LINUX_STATE_ROOT}/backups'
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
/usr/bin/systemctl restart '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications >/dev/null 2>&1 || true; fi
exit 0
`;
}

export function linuxDebPreRemoveScript(): string {
  return `#!/bin/sh
set -eu
case "\${1:-remove}" in
  remove|purge|upgrade|deconfigure)
    if [ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ]; then
      /usr/bin/systemctl stop '${LINUX_API_SERVICE}' '${LINUX_RENDERER_SERVICE}' >/dev/null 2>&1 || true
      if [ "\${1:-remove}" = remove ] || [ "\${1:-remove}" = purge ]; then
        /usr/bin/systemctl disable '${LINUX_API_SERVICE}' '${LINUX_RENDERER_SERVICE}' >/dev/null 2>&1 || true
      fi
    fi
    ;;
esac
exit 0
`;
}

export function linuxDebPostRemoveScript(): string {
  return `#!/bin/sh
set -eu
if [ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ]; then /usr/bin/systemctl daemon-reload || true; fi
echo 'FormaSpec application data and backups remain in ${LINUX_STATE_ROOT}/data and ${LINUX_STATE_ROOT}/backups.'
echo 'Remove them only after verifying an independent backup.'
exit 0
`;
}

export function linuxRpmPreInstallScript(): string {
  return `set -eu
[ "$(id -u)" -eq 0 ] || { echo 'FormaSpec package installation must run as root.' >&2; exit 1; }
${managedInstallChecks()}${systemUserSetup()}`;
}

export function linuxRpmPostInstallScript(): string {
  return `set -eu
[ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ] || { echo 'FormaSpec requires a running systemd system instance.' >&2; exit 1; }
install -d -m 0750 -o '${LINUX_SERVICE_USER}' -g '${LINUX_SERVICE_USER}' '${LINUX_STATE_ROOT}' '${LINUX_STATE_ROOT}/data' '${LINUX_STATE_ROOT}/backups'
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
/usr/bin/systemctl restart '${LINUX_RENDERER_SERVICE}' '${LINUX_API_SERVICE}'
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications >/dev/null 2>&1 || true; fi`;
}

export function linuxRpmPreRemoveScript(): string {
  return `set -eu
if [ "\${1:-0}" -eq 0 ]; then
  if [ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ]; then
    /usr/bin/systemctl disable --now '${LINUX_API_SERVICE}' '${LINUX_RENDERER_SERVICE}' >/dev/null 2>&1 || true
  fi
fi`;
}

export function linuxRpmPostRemoveScript(): string {
  return `set -eu
if [ -x /usr/bin/systemctl ] && [ -d /run/systemd/system ]; then /usr/bin/systemctl daemon-reload || true; fi
if [ "\${1:-0}" -eq 0 ]; then
  echo 'FormaSpec application data and backups remain in ${LINUX_STATE_ROOT}/data and ${LINUX_STATE_ROOT}/backups.'
  echo 'Remove them only after verifying an independent backup.'
fi`;
}
