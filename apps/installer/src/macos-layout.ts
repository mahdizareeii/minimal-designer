export const MACOS_INSTALL_ROOT = "/Library/Application Support/FormaSpec";
export const MACOS_API_LABEL = "com.formaspec.api";
export const MACOS_RENDERER_LABEL = "com.formaspec.renderer";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function assertPackageVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
    throw new Error("Installer version must be a semantic version without whitespace.");
  }
  return value;
}

export function launchAgentPlist(label: string, executable: string): string {
  if (!/^com\.formaspec\.[a-z0-9.-]+$/.test(label)) throw new Error("LaunchAgent label is invalid.");
  if (!executable.startsWith(`${MACOS_INSTALL_ROOT}/bin/`)) throw new Error("LaunchAgent executable is outside the install root.");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(executable)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
`;
}

function servicePreamble(): string {
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${MACOS_INSTALL_ROOT}'
USER_ROOT="\${HOME}/Library/Application Support/FormaSpec"
RUNTIME_ROOT="\${USER_ROOT}/runtime"
mkdir -p "\${USER_ROOT}/data" "\${USER_ROOT}/backups" "\${USER_ROOT}/run" "\${USER_ROOT}/logs" "\${RUNTIME_ROOT}/run" "\${RUNTIME_ROOT}/logs"
chmod 700 "\${USER_ROOT}" "\${USER_ROOT}/data" "\${USER_ROOT}/backups" "\${USER_ROOT}/run" "\${USER_ROOT}/logs" "\${RUNTIME_ROOT}" "\${RUNTIME_ROOT}/run" "\${RUNTIME_ROOT}/logs"
export PATH="\${INSTALL_ROOT}/runtime:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="\${INSTALL_ROOT}/runtime/ms-playwright"
export NODE_ENV=production
`;
}

export function rendererWrapper(): string {
  return `${servicePreamble()}export FORMASPEC_RENDER_SOCKET="\${USER_ROOT}/run/renderer.sock"
export FORMASPEC_RENDER_TIMEOUT_MS=15000
export FORMASPEC_RENDER_MAX_PIXELS=32000000
export DESIGNER_MAX_ASSET_PIXELS=32000000
export MAX_UPLOAD_BYTES=5242880
export FORMASPEC_RENDER_CONCURRENCY=2
export FORMASPEC_RENDER_QUEUE_LIMIT=32
export FORMASPEC_RENDER_IPC_MAX_BYTES=100663296
export FORMASPEC_ALLOW_SYSTEM_CHROME=false
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/server/dist/renderer-worker.js" >>"\${USER_ROOT}/logs/renderer.log" 2>&1
`;
}

export function apiWrapper(): string {
  return `${servicePreamble()}export APP_MODE=local
export HOST=127.0.0.1
export PORT=4310
export DATA_DIR="\${USER_ROOT}/data"
export BACKUP_DIR="\${USER_ROOT}/backups"
export PUBLIC_BASE_URL=http://127.0.0.1:4310
export AUTH_MODE=none
export FORMASPEC_RENDER_SOCKET="\${USER_ROOT}/run/renderer.sock"
export FORMASPEC_RENDER_TIMEOUT_MS=15000
export FORMASPEC_RENDER_MAX_PIXELS=32000000
export DESIGNER_MAX_ASSET_PIXELS=32000000
export MAX_UPLOAD_BYTES=5242880
export FORMASPEC_RENDER_IPC_MAX_BYTES=100663296
export FORMASPEC_ALLOW_SYSTEM_CHROME=false
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/server/dist/index.js" >>"\${USER_ROOT}/logs/api.log" 2>&1
`;
}

export function formaspecctlWrapper(): string {
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${MACOS_INSTALL_ROOT}'
[ -n "\${HOME:-}" ] || { echo 'HOME is required for per-user FormaSpec state.' >&2; exit 2; }
STATE_ROOT="\${HOME}/Library/Application Support/FormaSpec"
export FORMASPEC_RUNTIME_DIR="\${FORMASPEC_RUNTIME_DIR:-\${STATE_ROOT}/runtime}"
export FORMASPEC_DATA_DIR="\${FORMASPEC_DATA_DIR:-\${STATE_ROOT}/data}"
export FORMASPEC_BACKUP_DIR="\${FORMASPEC_BACKUP_DIR:-\${STATE_ROOT}/backups}"
export FORMASPEC_LOG_DIR="\${FORMASPEC_LOG_DIR:-\${STATE_ROOT}/logs}"
export FORMASPEC_SUPPORT_DIR="\${FORMASPEC_SUPPORT_DIR:-\${STATE_ROOT}/support-bundles}"
export PATH="\${INSTALL_ROOT}/runtime:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:\${PATH:-}"
export PLAYWRIGHT_BROWSERS_PATH="\${INSTALL_ROOT}/runtime/ms-playwright"
if [ "\${1:-}" = install ] && [ "$#" -eq 1 ]; then set -- install local; fi
if [ "\${1:-}" = start ] && [ "$#" -eq 1 ]; then set -- start local; fi
exec "\${INSTALL_ROOT}/runtime/node" "\${INSTALL_ROOT}/app/apps/cli/dist/index.js" "$@"
`;
}

export function compatibilityLauncher(version: string): string {
  assertPackageVersion(version);
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${MACOS_INSTALL_ROOT}'
if [ "\${FORMASPEC_LEGACY_DELEGATE:-0}" != 1 ]; then
  DELEGATE_COMMAND=''
  for ARG in "$@"; do
    case "\${ARG}" in --yes|--no-open) ;; *) DELEGATE_COMMAND="\${ARG}"; break ;; esac
  done
  case "\${DELEGATE_COMMAND}" in
    doctor|status|start|stop|restart) exec "\${INSTALL_ROOT}/bin/formaspecctl" "$@" ;;
  esac
fi
RUNTIME_ROOT="\${FORMASPEC_RUNTIME_DIR:-\${HOME}/Library/Application Support/FormaSpec/runtime}"
RUN_ROOT="\${RUNTIME_ROOT}/run"
NO_OPEN=0
while [ "\${1:-}" = "--yes" ] || [ "\${1:-}" = "--no-open" ]; do
  if [ "$1" = "--no-open" ]; then NO_OPEN=1; fi
  shift
done
COMMAND="\${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
service_loaded() { launchctl print "gui/\$(id -u)/$1" >/dev/null 2>&1; }
load_service() {
  LABEL="$1"
  PLIST="/Library/LaunchAgents/\${LABEL}.plist"
  if ! service_loaded "\${LABEL}"; then launchctl bootstrap "gui/\$(id -u)" "\${PLIST}"; fi
  launchctl enable "gui/\$(id -u)/\${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/\$(id -u)/\${LABEL}"
}
record_state() {
  mkdir -p "\${RUN_ROOT}"
  chmod 700 "\${RUNTIME_ROOT}" "\${RUN_ROOT}"
  printf 'local\n' >"\${RUN_ROOT}/mode"
  printf '4310\n' >"\${RUN_ROOT}/api-port"
  printf 'http://127.0.0.1:4310\n' >"\${RUN_ROOT}/url"
  chmod 600 "\${RUN_ROOT}/mode" "\${RUN_ROOT}/api-port" "\${RUN_ROOT}/url"
}
start_services() {
  load_service '${MACOS_RENDERER_LABEL}'
  load_service '${MACOS_API_LABEL}'
  record_state
  ATTEMPT=0
  while [ "\${ATTEMPT}" -lt 80 ]; do
    if /usr/bin/curl -fsS http://127.0.0.1:4310/health/ready >/dev/null 2>&1; then
      if [ "\${NO_OPEN}" -ne 1 ]; then /usr/bin/open http://127.0.0.1:4310; fi
      return 0
    fi
    ATTEMPT=\$((ATTEMPT + 1))
    sleep 0.1
  done
  echo 'FormaSpec did not become ready. Inspect ~/Library/Application Support/FormaSpec/logs.' >&2
  return 1
}
case "\${COMMAND}" in
  help|-h|--help)
    echo 'Packaged FormaSpec launcher: setup local | start local | stop | restart | status | doctor local | logs | version'
    ;;
  version|--version) echo 'FormaSpec ${version}' ;;
  setup)
    [ "\${1:-local}" = "local" ] || { echo 'The macOS package supports the bundled local runtime only.' >&2; exit 2; }
    [ -x "\${INSTALL_ROOT}/runtime/node" ]
    [ -f "\${INSTALL_ROOT}/app/apps/server/dist/index.js" ]
    [ -d "\${INSTALL_ROOT}/runtime/ms-playwright" ]
    ;;
  start)
    [ "\${1:-local}" = "local" ] || { echo 'The macOS package supports the bundled local runtime only.' >&2; exit 2; }
    start_services
    ;;
  stop)
    launchctl bootout "gui/\$(id -u)/${MACOS_API_LABEL}" >/dev/null 2>&1 || true
    launchctl bootout "gui/\$(id -u)/${MACOS_RENDERER_LABEL}" >/dev/null 2>&1 || true
    ;;
  restart)
    "$0" stop
    start_services
    ;;
  status)
    /usr/bin/curl -fsS http://127.0.0.1:4310/health/ready
    ;;
  doctor)
    [ "\${1:-local}" = "local" ] || [ "\${1:-auto}" = "auto" ] || { echo 'Use doctor local or doctor auto.' >&2; exit 2; }
    "$0" setup local
    /usr/bin/curl -fsS http://127.0.0.1:4310/health/ready
    ;;
  logs)
    /usr/bin/tail -n 200 "\${HOME}/Library/Application Support/FormaSpec/logs/api.log" "\${HOME}/Library/Application Support/FormaSpec/logs/renderer.log"
    ;;
  *) echo "Unsupported packaged launcher command: \${COMMAND}" >&2; exit 2 ;;
esac
`;
}

export function protocolHandler(): string {
  return `#!/bin/sh
set -eu
URL="\${1:-}"
LOG_ROOT="\${HOME}/Library/Logs/FormaSpec"
FORMASPECCTL='/usr/local/bin/formaspecctl'
OPEN='/usr/bin/open'
mkdir -p "\${LOG_ROOT}"
chmod 700 "\${LOG_ROOT}"
reject_protocol_url() { echo 'Unsupported or malformed FormaSpec URL.' >>"\${LOG_ROOT}/protocol.log"; exit 2; }
validate_pairing_nonce() {
  [ "\${#1}" -eq 50 ] || reject_protocol_url
  case "$1" in fspair_*) ;; *) reject_protocol_url ;; esac
  case "$1" in *[!A-Za-z0-9_-]*) reject_protocol_url ;; esac
}
validate_connection_id() {
  [ "\${#1}" -eq 43 ] || reject_protocol_url
  case "$1" in connection_*) HEX="\${1#connection_}" ;; *) reject_protocol_url ;; esac
  [ "\${#HEX}" -eq 32 ] || reject_protocol_url
  case "\${HEX}" in *[!a-f0-9]*) reject_protocol_url ;; esac
}
[ "\${#URL}" -le 512 ] || reject_protocol_url
case "\${URL}" in *[!A-Za-z0-9_:?\\&=/_-]*) reject_protocol_url ;; esac
case "\${URL}" in
  ''|formaspec://|formaspec://open)
    ;;
  formaspec://connect-agent)
    "\${FORMASPECCTL}" agent connect codex --yes >>"\${LOG_ROOT}/protocol.log" 2>&1 &
    ;;
  formaspec://connect-agent\?nonce=*)
    PAIRING_NONCE="\${URL#formaspec://connect-agent?nonce=}"
    validate_pairing_nonce "\${PAIRING_NONCE}"
    "\${FORMASPECCTL}" agent connect codex --pairing-nonce "\${PAIRING_NONCE}" --yes >>"\${LOG_ROOT}/protocol.log" 2>&1 &
    ;;
  formaspec://connect-agent\?connection=*)
    REST="\${URL#formaspec://connect-agent?connection=}"
    CONNECTION_ID="\${REST%%&nonce=*}"
    PAIRING_NONCE="\${REST#*&nonce=}"
    [ "\${REST}" = "\${CONNECTION_ID}&nonce=\${PAIRING_NONCE}" ] || reject_protocol_url
    validate_connection_id "\${CONNECTION_ID}"
    validate_pairing_nonce "\${PAIRING_NONCE}"
    "\${FORMASPECCTL}" agent connect codex --pairing-nonce "\${PAIRING_NONCE}" --connection-id "\${CONNECTION_ID}" --yes >>"\${LOG_ROOT}/protocol.log" 2>&1 &
    ;;
  *) reject_protocol_url ;;
esac
"\${OPEN}" http://127.0.0.1:4310
`;
}

export function applicationInfoPlist(version: string): string {
  assertPackageVersion(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>FormaSpec</string>
  <key>CFBundleExecutable</key><string>FormaSpec</string>
  <key>CFBundleIdentifier</key><string>com.formaspec.app</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>FormaSpec</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>
  <key>CFBundleVersion</key><string>${xml(version)}</string>
  <key>LSBackgroundOnly</key><false/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>FormaSpec Agent Connection</string>
    <key>CFBundleURLSchemes</key><array><string>formaspec</string></array>
  </dict></array>
</dict></plist>
`;
}

export function preinstallScript(): string {
  return `#!/bin/sh
set -eu
INSTALL_ROOT='${MACOS_INSTALL_ROOT}'
if [ -e "\${INSTALL_ROOT}" ] && [ ! -f "\${INSTALL_ROOT}/install-manifest.json" ]; then
  echo 'Refusing to replace an unmanaged /Library/Application Support/FormaSpec directory.' >&2
  exit 1
fi
if [ -e /usr/local/bin/formaspecctl ] && ! /usr/bin/grep -Fq "INSTALL_ROOT='${MACOS_INSTALL_ROOT}'" /usr/local/bin/formaspecctl; then
  echo 'Refusing to replace an unmanaged /usr/local/bin/formaspecctl.' >&2
  exit 1
fi
if [ -e /Applications/FormaSpec.app ]; then
  BUNDLE_ID="\$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/FormaSpec.app/Contents/Info.plist 2>/dev/null || true)"
  if [ "\${BUNDLE_ID}" != com.formaspec.app ]; then
    echo 'Refusing to replace an unmanaged /Applications/FormaSpec.app.' >&2
    exit 1
  fi
fi
CONSOLE_USER="\$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true)"
if [ -n "\${CONSOLE_USER}" ] && [ "\${CONSOLE_USER}" != root ]; then
  USER_ID="\$(/usr/bin/id -u "\${CONSOLE_USER}")"
  /bin/launchctl bootout "gui/\${USER_ID}/${MACOS_API_LABEL}" >/dev/null 2>&1 || true
  /bin/launchctl bootout "gui/\${USER_ID}/${MACOS_RENDERER_LABEL}" >/dev/null 2>&1 || true
fi
exit 0
`;
}

export function postinstallScript(): string {
  return `#!/bin/sh
set -eu
CONSOLE_USER="\$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true)"
if [ -z "\${CONSOLE_USER}" ] || [ "\${CONSOLE_USER}" = root ]; then exit 0; fi
USER_ID="\$(/usr/bin/id -u "\${CONSOLE_USER}")"
USER_HOME="\$(/usr/bin/dscl . -read "/Users/\${CONSOLE_USER}" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
USER_ROOT="\${USER_HOME}/Library/Application Support/FormaSpec"
/usr/bin/install -d -m 700 -o "\${CONSOLE_USER}" -g staff "\${USER_ROOT}" "\${USER_ROOT}/data" "\${USER_ROOT}/backups" "\${USER_ROOT}/run" "\${USER_ROOT}/logs" "\${USER_ROOT}/runtime" "\${USER_ROOT}/runtime/run" "\${USER_ROOT}/runtime/logs"
for LABEL in '${MACOS_RENDERER_LABEL}' '${MACOS_API_LABEL}'; do
  /bin/launchctl asuser "\${USER_ID}" /bin/launchctl bootstrap "gui/\${USER_ID}" "/Library/LaunchAgents/\${LABEL}.plist" >/dev/null 2>&1 || true
  /bin/launchctl asuser "\${USER_ID}" /bin/launchctl enable "gui/\${USER_ID}/\${LABEL}" >/dev/null 2>&1 || true
  /bin/launchctl asuser "\${USER_ID}" /bin/launchctl kickstart -k "gui/\${USER_ID}/\${LABEL}" >/dev/null 2>&1 || true
done
LSREGISTER='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if [ -x "\${LSREGISTER}" ]; then "\${LSREGISTER}" -f /Applications/FormaSpec.app >/dev/null 2>&1 || true; fi
/bin/launchctl asuser "\${USER_ID}" /usr/bin/open http://127.0.0.1:4310 >/dev/null 2>&1 || true
exit 0
`;
}
