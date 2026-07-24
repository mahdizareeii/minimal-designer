#!/usr/bin/env bash

# Non-mutating contract tests for the FormaSpec compatibility launcher.
# The launcher is always given an isolated runtime directory, and commands that
# could install packages or start containers use harmless PATH stubs.

set -u
set -o pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHER="$PROJECT_ROOT/designer"

PASS_COUNT=0
FAIL_COUNT=0
CAPTURE_INDEX=0
CAPTURE_STATUS=0
CAPTURE_OUTPUT=""
SENSITIVE_TOKEN="designer-test-secret-0123456789"
SENSITIVE_PROXY_SECRET="proxy-test-secret-0123456789abcdef0123456789abcdef"

# These tests exercise the Bash compatibility implementation itself. The
# separately tested formaspecctl wrapper normally delegates supported commands
# back into this launcher with the same guard.
export FORMASPEC_LEGACY_DELEGATE=1

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/minimal-designer-launcher.XXXXXX")" || exit 1

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

pass_test() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"
}

fail_test() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'not ok %d - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1" >&2
}

show_capture() {
  local safe_output="$CAPTURE_OUTPUT"
  safe_output="${safe_output//$SENSITIVE_TOKEN/[REDACTED]}"
  if [ -n "$safe_output" ]; then
    printf '%s\n' "$safe_output" | sed 's/^/    /' >&2
  fi
}

capture() {
  local output_file="$TMP_ROOT/capture-$CAPTURE_INDEX.log"
  CAPTURE_INDEX=$((CAPTURE_INDEX + 1))
  "$@" >"$output_file" 2>&1
  CAPTURE_STATUS=$?
  CAPTURE_OUTPUT="$(cat "$output_file")"
}

capture_in_dir() {
  local directory="$1"
  local output_file
  shift
  output_file="$TMP_ROOT/capture-$CAPTURE_INDEX.log"
  CAPTURE_INDEX=$((CAPTURE_INDEX + 1))
  (cd "$directory" && "$@") >"$output_file" 2>&1
  CAPTURE_STATUS=$?
  CAPTURE_OUTPUT="$(cat "$output_file")"
}

expect_status() {
  local expected="$1" label="$2"
  if [ "$CAPTURE_STATUS" -eq "$expected" ]; then
    pass_test "$label"
  else
    fail_test "$label (expected exit $expected, got $CAPTURE_STATUS)"
    show_capture
  fi
}

expect_status_zero_or_one() {
  local label="$1"
  case "$CAPTURE_STATUS" in
    0|1) pass_test "$label" ;;
    *)
      fail_test "$label (expected exit 0 or 1, got $CAPTURE_STATUS)"
      show_capture
      ;;
  esac
}

expect_contains() {
  local needle="$1" label="$2"
  case "$CAPTURE_OUTPUT" in
    *"$needle"*) pass_test "$label" ;;
    *)
      fail_test "$label (missing expected text)"
      show_capture
      ;;
  esac
}

expect_not_contains() {
  local needle="$1" label="$2"
  case "$CAPTURE_OUTPUT" in
    *"$needle"*) fail_test "$label (sensitive or forbidden text was emitted)" ;;
    *) pass_test "$label" ;;
  esac
}

expect_absent() {
  local path="$1" label="$2"
  if [ ! -e "$path" ]; then
    pass_test "$label"
  else
    fail_test "$label (unexpected path: $path)"
  fi
}

expect_file_contains() {
  local path="$1" needle="$2" label="$3"
  if [ -f "$path" ] && grep -F -- "$needle" "$path" >/dev/null 2>&1; then
    pass_test "$label"
  else
    fail_test "$label (missing expected file content)"
    if [ -f "$path" ]; then
      local safe_content
      safe_content="$(cat "$path")"
      safe_content="${safe_content//$SENSITIVE_TOKEN/[REDACTED]}"
      printf '%s\n' "$safe_content" | sed 's/^/    /' >&2
    fi
  fi
}

expect_file_not_contains() {
  local path="$1" needle="$2" label="$3"
  if [ ! -f "$path" ] || ! grep -F -- "$needle" "$path" >/dev/null 2>&1; then
    pass_test "$label"
  else
    fail_test "$label (forbidden file content was found)"
  fi
}

expect_equal() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then
    pass_test "$label"
  else
    fail_test "$label (values differ)"
  fi
}

make_stub_toolchain() {
  MOCK_BIN="$TMP_ROOT/mock toolchain/bin"
  mkdir -p "$MOCK_BIN"

  cat >"$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
if [ "${DESIGNER_TEST_NODE_UNAVAILABLE:-0}" = "1" ]; then
  exit 127
fi
if [ "${1:-}" = "--version" ]; then
  printf 'v24.1.0\n'
  exit 0
fi
if [ -n "${DESIGNER_TEST_MUTATION_LOG:-}" ]; then
  printf 'node %s\n' "$*" >>"$DESIGNER_TEST_MUTATION_LOG"
fi
exit 0
EOF

  cat >"$MOCK_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf '11.9.0\n'
  exit 0
fi
if [ -n "${DESIGNER_TEST_MUTATION_LOG:-}" ]; then
  printf 'pnpm %s\n' "$*" >>"$DESIGNER_TEST_MUTATION_LOG"
fi
exit 0
EOF

  cat >"$MOCK_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version)
    printf 'Docker version 28.0.0, build test\n'
    exit 0
    ;;
  info)
    # Deliberately model an installed CLI with a stopped daemon.
    if [ "${DESIGNER_TEST_DOCKER_DAEMON:-stopped}" = "ready" ]; then
      exit 0
    fi
    exit 1
    ;;
  ps)
    if [ -n "${DESIGNER_TEST_DOCKER_PROJECT_STATE:-}" ]; then
      printf '%s\n' "$DESIGNER_TEST_DOCKER_PROJECT_STATE"
    elif [ "${DESIGNER_TEST_DOCKER_PROJECT_RUNNING:-0}" = "1" ]; then
      printf '%s\n' 'running'
    fi
    exit 0
    ;;
  compose)
    if [ "${2:-}" = "version" ]; then
      printf 'Docker Compose version v2.35.0\n'
      exit 0
    fi
    for argument in "$@"; do
      if [ "$argument" = "logs" ]; then
        printf '%s\n' "${DESIGNER_TEST_DOCKER_LOG_OUTPUT:-fake active Docker log}"
        exit 0
      fi
    done
    if [ -n "${DESIGNER_TEST_MUTATION_LOG:-}" ]; then
      printf 'docker %s\n' "$*" >>"$DESIGNER_TEST_MUTATION_LOG"
    fi
    exit 0
    ;;
esac
exit 0
EOF

  cat >"$MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [ -n "${DESIGNER_TEST_PS_COMMAND:-}" ]; then
  printf '%s\n' "$DESIGNER_TEST_PS_COMMAND"
fi
exit 0
EOF

  cat >"$MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

  cat >"$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [ -n "${DESIGNER_TEST_CURL_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$DESIGNER_TEST_CURL_LOG"
fi
if [ -n "${DESIGNER_TEST_EXPECT_PROXY_SECRET:-}" ]; then
  expects_config=0
  for argument in "$@"; do
    if [ "$expects_config" = "1" ] && [ "$argument" = "-" ]; then
      config_data="$(cat)"
      case "$config_data" in
        *"x-formaspec-proxy-secret: ${DESIGNER_TEST_EXPECT_PROXY_SECRET}"*) ;;
        *) exit 1 ;;
      esac
      break
    fi
    if [ "$argument" = "--config" ]; then expects_config=1; else expects_config=0; fi
  done
fi
if [ "${DESIGNER_TEST_CURL_OK:-0}" = "1" ]; then
  exit 0
fi
exit 1
EOF

  chmod +x "$MOCK_BIN/node" "$MOCK_BIN/pnpm" "$MOCK_BIN/docker" "$MOCK_BIN/ps" "$MOCK_BIN/lsof" "$MOCK_BIN/curl"
  MOCK_PATH="$MOCK_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

run_static_contract_tests() {
  capture bash -n "$LAUNCHER"
  expect_status 0 "launcher has valid Bash syntax"

  if [ -x "$LAUNCHER" ]; then
    pass_test "launcher is executable"
  else
    fail_test "launcher is executable (run: chmod +x designer)"
  fi

  local menu_input="$TMP_ROOT/menu-input.txt"
  printf '5\n' >"$menu_input"
  capture bash -c 'bash "$1" <"$2"' _ "$LAUNCHER" "$menu_input"
  expect_status 0 "no-argument guided menu works on Bash with nounset enabled"
  expect_contains "guided launcher" "no-argument invocation displays the guided menu"
  expect_contains "FormaSpec launcher" "guided menu can select help"

  capture bash "$LAUNCHER" help
  expect_status 0 "help exits successfully"
  expect_contains "FormaSpec launcher" "help identifies the launcher"
  expect_contains "--dry-run" "help documents dry-run mode"
  expect_contains "recorded Docker/server runtime" "help documents supervised server restore through formaspecctl"

  capture bash "$LAUNCHER" version
  expect_status 0 "version exits successfully"
  if printf '%s\n' "$CAPTURE_OUTPUT" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    pass_test "version prints a semantic version"
  else
    fail_test "version prints a semantic version"
    show_capture
  fi

  capture bash "$LAUNCHER" definitely-not-a-command
  expect_status 2 "unknown command returns a usage error"
  expect_contains "Unknown command" "unknown command explains the error"

  expect_file_contains "$PROJECT_ROOT/Dockerfile" \
    "FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48" \
    "Docker image pins the human-readable Playwright tag to the cached registry digest"

  local designer_service
  designer_service="$(sed -n '/^  designer:/,/^  restore-worker:/p' "$PROJECT_ROOT/docker-compose.yml")"
  case "$designer_service" in
    *"pids_limit: 256"*"mem_limit: 2g"*"cpus: \"2.0\""*)
      pass_test "Compose bounds the API service PID, memory, and CPU resources"
      ;;
    *) fail_test "Compose bounds the API service PID, memory, and CPU resources" ;;
  esac
  case "$designer_service" in
    *'FORMASPEC_PROXY_SECRET: ${FORMASPEC_PROXY_SECRET:-}'*)
      pass_test "Compose propagates the internal proxy secret only through the managed environment"
      ;;
    *) fail_test "Compose propagates the internal proxy secret only through the managed environment" ;;
  esac
}

run_location_and_read_only_tests() {
  local outside_dir="$TMP_ROOT/outside repository cwd with spaces"
  local outside_runtime="$TMP_ROOT/outside-runtime-must-not-exist"
  mkdir -p "$outside_dir"

  capture_in_dir "$outside_dir" env \
    DESIGNER_RUNTIME_DIR="$outside_runtime" \
    bash "$LAUNCHER" plan auto
  expect_status 0 "launcher works outside the repository from a path containing spaces"
  expect_contains "Plan only" "outside-repository invocation resolves the launcher correctly"
  expect_absent "$outside_runtime" "outside-repository plan creates no runtime state"

  local doctor_runtime="$TMP_ROOT/doctor-runtime-must-not-exist"
  capture env \
    DESIGNER_RUNTIME_DIR="$doctor_runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor auto
  # Doctor intentionally returns 1 when neither supported runtime is ready.
  expect_status_zero_or_one "doctor completes with a documented readiness status"
  expect_contains "FormaSpec doctor" "doctor prints its diagnostic heading"
  expect_contains "server readiness" "doctor checks the running FormaSpec server instead of only prerequisites"
  expect_contains "local bridge" "doctor checks the supervised local bridge"
  expect_absent "$doctor_runtime" "doctor creates no runtime state"

  local target runtime
  for target in auto local docker server; do
    runtime="$TMP_ROOT/plan-$target-runtime-must-not-exist"
    capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" plan "$target"
    expect_status 0 "plan $target exits successfully"
    expect_contains "Plan only" "plan $target declares that it is non-mutating"
    expect_absent "$runtime" "plan $target creates no runtime state"
  done
}

run_dry_run_tests() {
  make_stub_toolchain

  local runtime mutation_log

  runtime="$TMP_ROOT/dry-setup-local-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-setup-local-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run setup local --skip-browser
  expect_status 0 "dry-run native setup exits successfully"
  expect_absent "$mutation_log" "dry-run native setup does not invoke pnpm mutations"
  expect_absent "$runtime" "dry-run native setup creates no runtime state"

  runtime="$TMP_ROOT/dry-install-local-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-install-local-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run --yes --no-open install local
  expect_status 0 "dry-run local installer exits without executing formaspecctl"
  expect_contains "formaspecctl was not executed" "dry-run local installer reports the CLI boundary"
  expect_absent "$mutation_log" "dry-run local installer invokes no package or CLI process"
  expect_absent "$runtime" "dry-run local installer creates no runtime state"

  runtime="$TMP_ROOT/dry-install-docker-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-install-docker-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run --yes --no-open install docker
  expect_status 0 "dry-run Docker installer exits without executing formaspecctl"
  expect_contains "Would start Docker" "dry-run Docker installer reports the stopped-daemon action"
  expect_contains "formaspecctl was not executed" "dry-run Docker installer reports the CLI boundary"
  expect_absent "$mutation_log" "dry-run Docker installer invokes no package, CLI, or Compose process"
  expect_absent "$runtime" "dry-run Docker installer creates no runtime state"

  runtime="$TMP_ROOT/dry-dev-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-dev-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run dev --api-port 54320 --web-port 54321 --skip-setup --no-open
  expect_status 0 "dry-run development mode exits successfully"
  expect_contains "_run-native" "dry-run development mode prints the child command"
  expect_absent "$mutation_log" "dry-run development mode starts no package process"
  expect_absent "$runtime" "dry-run development mode creates no runtime state"

  runtime="$TMP_ROOT/dry-start-local-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-start-local-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run start local --port 54322 --no-open
  expect_status 0 "dry-run local production start exits successfully"
  expect_absent "$mutation_log" "dry-run local production start invokes no package mutation"
  expect_absent "$runtime" "dry-run local production start creates no logs or runtime state"

  runtime="$TMP_ROOT/dry-setup-docker-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-setup-docker-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run setup docker
  expect_status 0 "dry-run Docker setup succeeds with a stopped daemon"
  expect_contains "Would start Docker" "dry-run Docker setup reports the stopped daemon action"
  expect_absent "$mutation_log" "dry-run Docker setup invokes no Compose mutation"
  expect_absent "$runtime" "dry-run Docker setup creates no runtime state"

  runtime="$TMP_ROOT/dry-start-docker-runtime-must-not-exist"
  mutation_log="$TMP_ROOT/dry-start-docker-mutations.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run start docker --port 54323 --no-build --no-open
  expect_status 0 "dry-run Docker start exits successfully"
  expect_contains "up -d" "dry-run Docker start prints the Compose action"
  expect_absent "$mutation_log" "dry-run Docker start does not call Compose up"
  expect_absent "$runtime" "dry-run Docker start creates no env or runtime state"
}

run_cli_validation_tests() {
  local case_index=0

  run_usage_case() {
    local slug="$1" label="$2" expected_text="$3"
    local runtime mutation_log
    shift 3
    case_index=$((case_index + 1))
    runtime="$TMP_ROOT/usage-$case_index-$slug-runtime-must-not-exist"
    mutation_log="$TMP_ROOT/usage-$case_index-$slug-mutations.log"
    capture env \
      PATH="$MOCK_PATH" \
      HOME="$TMP_ROOT/home" \
      DESIGNER_RUNTIME_DIR="$runtime" \
      DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
      DESIGNER_NO_OPEN=1 \
      bash "$LAUNCHER" --dry-run "$@"
    expect_status 2 "$label"
    expect_contains "$expected_text" "$label explains the invalid option"
    expect_absent "$mutation_log" "$label invokes no package or Compose mutation"
    expect_absent "$runtime" "$label creates no runtime state"
  }

  run_usage_case "dev-api-port" \
    "dev rejects --api-port without a value" \
    "--api-port needs a value" \
    dev --api-port
  run_usage_case "dev-web-port" \
    "dev rejects --web-port without a value" \
    "--web-port needs a value" \
    dev --web-port
  run_usage_case "docker-port" \
    "Docker start rejects --port without a value" \
    "--port needs a value" \
    start docker --port
  run_usage_case "docker-skip-browser" \
    "Docker setup rejects the local-only --skip-browser flag" \
    "--skip-browser" \
    setup docker --skip-browser
  run_usage_case "server-port" \
    "server start rejects the ignored --port flag" \
    "--port" \
    start server --port 54326
  run_usage_case "local-no-build" \
    "local start rejects the Docker-only --no-build flag" \
    "--no-build" \
    start local --no-build
  run_usage_case "server-no-open" \
    "server start rejects the ignored --no-open flag" \
    "--no-open" \
    start server --no-open
  run_usage_case "server-conflicting-access" \
    "server init rejects simultaneous SSH-only and public-proxy modes" \
    "--ssh-only" \
    server init --ssh-only --public-url https://designer.example.test
}

run_server_security_tests() {
  local runtime="$TMP_ROOT/dry-server-init-runtime-must-not-exist"

  capture env \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run server init \
      --public-url https://designer.example.test \
      --port 54324 \
      --token "$SENSITIVE_TOKEN" \
      --identity-header X-Designer-User \
      --force
  expect_status 0 "dry-run trusted-proxy server initialization exits successfully"
  expect_contains "secret redacted" "dry-run server initialization labels secret output as redacted"
  expect_not_contains "$SENSITIVE_TOKEN" "dry-run server initialization never prints the bearer token"
  expect_absent "$runtime" "dry-run server initialization creates no secret or runtime files"

  runtime="$TMP_ROOT/invalid-http-runtime-must-not-exist"
  capture env \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run server init \
      --public-url http://designer.example.test \
      --token "$SENSITIVE_TOKEN" \
      --force
  expect_status 1 "plain-HTTP public server URL is rejected"
  expect_contains "HTTPS origin" "plain-HTTP rejection explains the HTTPS requirement"
  expect_not_contains "$SENSITIVE_TOKEN" "invalid server configuration never echoes the bearer token"
  expect_absent "$runtime" "rejected server initialization creates no runtime state"

  local invalid_header invalid_header_index=0
  for invalid_header in \
    host \
    origin \
    authorization \
    x-forwarded-user \
    x-auth-user \
    x-formaspec-csrf \
    x-formaspec-proxy-secret \
    x-request-id
  do
    invalid_header_index=$((invalid_header_index + 1))
    runtime="$TMP_ROOT/invalid-identity-header-$invalid_header_index-must-not-exist"
    capture env \
      DESIGNER_RUNTIME_DIR="$runtime" \
      DESIGNER_NO_OPEN=1 \
      bash "$LAUNCHER" server init \
        --public-url https://designer.example.test \
        --token "$SENSITIVE_TOKEN" \
        --identity-header "$invalid_header" \
        --force
    expect_status 1 "server init rejects reserved identity header $invalid_header"
    expect_contains "Invalid trusted identity header" "reserved identity header $invalid_header has an actionable error"
    expect_not_contains "$SENSITIVE_TOKEN" "reserved identity header $invalid_header never echoes the bearer token"
    expect_absent "$runtime" "reserved identity header $invalid_header fails before runtime state is written"
  done

  local generated_runtime="$TMP_ROOT/generated-server-runtime"
  local generated_env="$generated_runtime/env/server.env"
  local generated_proxy_secret generated_token generated_mode generated_auth_mode generated_bootstrap_hash generated_bootstrap_token generated_bootstrap_mode computed_bootstrap_hash
  capture env \
    DESIGNER_RUNTIME_DIR="$generated_runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" server init \
      --public-url https://generated.example.test \
      --token "$SENSITIVE_TOKEN" \
      --force
  expect_status 0 "server init generates a separate internal proxy secret"
  generated_proxy_secret="$(awk -F= '$1 == "FORMASPEC_PROXY_SECRET" { print substr($0, index($0, "=") + 1) }' "$generated_env")"
  generated_token="$(awk -F= '$1 == "DESIGNER_TOKEN" { print substr($0, index($0, "=") + 1) }' "$generated_env")"
  generated_auth_mode="$(awk -F= '$1 == "AUTH_MODE" { print substr($0, index($0, "=") + 1) }' "$generated_env")"
  generated_bootstrap_hash="$(awk -F= '$1 == "FORMASPEC_BOOTSTRAP_TOKEN_HASH" { print substr($0, index($0, "=") + 1) }' "$generated_env")"
  generated_bootstrap_token="$(cat "$generated_runtime/env/bootstrap-token")"
  generated_mode="$(stat -c '%a' "$generated_env" 2>/dev/null || stat -f '%Lp' "$generated_env" 2>/dev/null || true)"
  generated_bootstrap_mode="$(stat -c '%a' "$generated_runtime/env/bootstrap-token" 2>/dev/null || stat -f '%Lp' "$generated_runtime/env/bootstrap-token" 2>/dev/null || true)"
  if command -v shasum >/dev/null 2>&1; then
    computed_bootstrap_hash="$(printf '%s' "$generated_bootstrap_token" | shasum -a 256 | awk '{print $1}')"
  else
    computed_bootstrap_hash="$(printf '%s' "$generated_bootstrap_token" | sha256sum | awk '{print $1}')"
  fi
  case "$generated_proxy_secret" in
    ''|*[!A-Za-z0-9._-]*) fail_test "generated proxy secret is bounded and header-safe" ;;
    *)
      if [ "${#generated_proxy_secret}" -ge 32 ] && [ "${#generated_proxy_secret}" -le 256 ]; then
        pass_test "generated proxy secret is bounded and header-safe"
      else
        fail_test "generated proxy secret is bounded and header-safe"
      fi
      ;;
  esac
  if [ "$generated_proxy_secret" != "$generated_token" ]; then
    pass_test "generated proxy secret never reuses DESIGNER_TOKEN"
  else
    fail_test "generated proxy secret never reuses DESIGNER_TOKEN"
  fi
  expect_equal "600" "$generated_mode" "generated server.env remains mode 0600"
  expect_equal "session" "$generated_auth_mode" "fresh public server initialization defaults to password sessions"
  expect_equal "600" "$generated_bootstrap_mode" "one-time bootstrap token is stored with mode 0600"
  expect_equal "$generated_bootstrap_hash" "$computed_bootstrap_hash" "server.env stores only the matching bootstrap-token hash"
  expect_file_not_contains "$generated_env" "$generated_bootstrap_token" "server.env never stores the plaintext bootstrap token"
  expect_not_contains "$generated_proxy_secret" "normal server init output never prints the generated proxy secret"

  capture env DESIGNER_RUNTIME_DIR="$generated_runtime" bash "$LAUNCHER" proxy-secret
  expect_status 0 "explicit operator proxy-secret retrieval succeeds"
  expect_equal "$generated_proxy_secret" "$CAPTURE_OUTPUT" "proxy-secret prints only the stored operator credential"

  local legacy_runtime="$TMP_ROOT/legacy-server-without-proxy-secret"
  mkdir -p "$legacy_runtime/env"
  grep -v '^FORMASPEC_PROXY_SECRET=' "$generated_env" >"$legacy_runtime/env/server.env"
  chmod 600 "$legacy_runtime/env/server.env"
  capture env DESIGNER_RUNTIME_DIR="$legacy_runtime" bash "$LAUNCHER" codex-config server
  expect_status 1 "existing trusted-proxy server.env without the new hop secret fails closed"
  expect_contains "requires a separate FORMASPEC_PROXY_SECRET" "legacy server.env validation gives an actionable migration error"
  expect_not_contains "$generated_proxy_secret" "legacy server.env validation never prints the generated credential"

  local ssh_runtime="$TMP_ROOT/generated-ssh-runtime"
  capture env DESIGNER_RUNTIME_DIR="$ssh_runtime" DESIGNER_NO_OPEN=1 bash "$LAUNCHER" server init --ssh-only --force
  expect_status 0 "SSH-only initialization succeeds without an internal proxy credential"
  expect_file_not_contains "$ssh_runtime/env/server.env" "FORMASPEC_PROXY_SECRET" "SSH-only server.env does not claim a proxy secret"

  local invalid_url invalid_slug invalid_index=0
  for invalid_url in \
    "https://designer.example.test/path" \
    "https://designer.example.test?x=1" \
    "https://user@designer.example.test" \
    "https://designer.example.test//"
  do
    invalid_index=$((invalid_index + 1))
    invalid_slug="invalid-origin-$invalid_index"
    runtime="$TMP_ROOT/$invalid_slug-runtime-must-not-exist"
    capture env \
      DESIGNER_RUNTIME_DIR="$runtime" \
      DESIGNER_NO_OPEN=1 \
      bash "$LAUNCHER" --dry-run server init \
        --public-url "$invalid_url" \
        --token "$SENSITIVE_TOKEN" \
        --force
    expect_status 1 "server init rejects non-origin URL form $invalid_index"
    expect_contains "HTTPS origin" "non-origin URL rejection $invalid_index explains the origin requirement"
    expect_not_contains "$SENSITIVE_TOKEN" "non-origin URL rejection $invalid_index never echoes the bearer token"
    expect_absent "$runtime" "non-origin URL rejection $invalid_index creates no runtime state"
  done

  runtime="$TMP_ROOT/single-trailing-slash-runtime-must-not-exist"
  capture env \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run server init \
      --public-url https://designer.example.test/ \
      --token "$SENSITIVE_TOKEN" \
      --force
  expect_status 0 "server init accepts a single trailing slash on an HTTPS origin"
  expect_not_contains "$SENSITIVE_TOKEN" "accepted trailing-slash origin still redacts the bearer token"
  expect_absent "$runtime" "accepted trailing-slash origin creates no dry-run state"

  local configured_runtime="$TMP_ROOT/configured-server-runtime"
  local server_env="$configured_runtime/env/server.env"
  local mutation_log="$TMP_ROOT/dry-start-server-mutations.log"
  local curl_log="$TMP_ROOT/server-health-curl.log"
  local checksum_before checksum_after
  mkdir -p "$configured_runtime/env"
  {
    printf 'DESIGNER_SERVER_ACCESS=proxy\n'
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=54325\n'
    printf 'PUBLIC_BASE_URL=https://designer.example.test\n'
    printf 'AUTH_MODE=trusted-header\n'
    printf 'DESIGNER_TOKEN=%s\n' "$SENSITIVE_TOKEN"
    printf 'FORMASPEC_PROXY_SECRET=%s\n' "$SENSITIVE_PROXY_SECRET"
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$server_env"
  chmod 600 "$server_env"
  checksum_before="$(cksum "$server_env")"

  capture env \
    DESIGNER_RUNTIME_DIR="$configured_runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" codex-config server
  expect_status 0 "server Codex configuration exits successfully"
  expect_contains "bearer_token_env_var" "server Codex configuration references an environment variable"
  expect_not_contains "$SENSITIVE_TOKEN" "server Codex configuration does not print the stored token"
  expect_not_contains "$SENSITIVE_PROXY_SECRET" "server Codex configuration does not print the internal proxy secret"

  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$configured_runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run start server --no-build
  expect_status 0 "dry-run server start succeeds with a stopped Docker daemon"
  expect_contains "up -d" "dry-run server start prints the Compose action"
  expect_not_contains "$SENSITIVE_TOKEN" "dry-run server start does not print the stored token"
  expect_absent "$mutation_log" "dry-run server start does not call Compose up"
  expect_absent "$configured_runtime/run" "dry-run server start creates no run-state directory"
  checksum_after="$(cksum "$server_env")"
  expect_equal "$checksum_before" "$checksum_after" "dry-run server start leaves the secure env unchanged"

  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$configured_runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_TEST_CURL_LOG="$curl_log" \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_TEST_EXPECT_PROXY_SECRET="$SENSITIVE_PROXY_SECRET" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --yes start server --no-build
  expect_status 0 "strict server start accepts a healthy loopback container"
  expect_file_contains "$curl_log" \
    "-H Host: designer.example.test http://127.0.0.1:54325/health/ready" \
    "strict server readiness uses /health/ready with the public Host header"
  expect_file_contains "$curl_log" \
    "--config - -H Host: designer.example.test -H x-designer-user: launcher-health-check http://127.0.0.1:54325/api/designs" \
    "strict server API verification preserves the public Host header and injects the secret through stdin"
  expect_file_not_contains "$curl_log" "$SENSITIVE_PROXY_SECRET" \
    "strict server API verification never exposes the proxy secret in process arguments or logs"
  expect_file_not_contains "$curl_log" "http://127.0.0.1:54325/ready" \
    "strict server startup never polls the legacy readiness endpoint"
}

run_codex_config_state_tests() {
  local runtime="$TMP_ROOT/codex-config-state-runtime"
  local env_dir="$runtime/env"
  local run_dir="$runtime/run"
  local server_env="$env_dir/server.env"
  local docker_env="$env_dir/docker.env"
  local docker_port=55601
  local local_port=55602
  local server_url="https://designer-config.example.test"

  mkdir -p "$env_dir" "$run_dir"
  {
    printf 'DESIGNER_SERVER_ACCESS=proxy\n'
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=55603\n'
    printf 'PUBLIC_BASE_URL=%s/\n' "$server_url"
    printf 'AUTH_MODE=trusted-header\n'
    printf 'DESIGNER_TOKEN=%s\n' "$SENSITIVE_TOKEN"
    printf 'FORMASPEC_PROXY_SECRET=%s\n' "$SENSITIVE_PROXY_SECRET"
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$server_env"
  {
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=%s\n' "$docker_port"
    printf 'PUBLIC_BASE_URL=http://127.0.0.1:%s\n' "$docker_port"
    printf 'AUTH_MODE=none\n'
    printf 'DESIGNER_TOKEN=\n'
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$docker_env"
  chmod 600 "$server_env" "$docker_env"

  printf 'docker\n' >"$run_dir/mode"
  printf '%s\n' "$docker_port" >"$run_dir/api-port"
  printf '0\n' >"$run_dir/web-port"
  printf 'http://127.0.0.1:%s\n' "$docker_port" >"$run_dir/url"
  printf '%s\n' "$docker_env" >"$run_dir/env-file"

  capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" codex-config auto
  expect_status 0 "automatic Codex config reads active Docker state"
  expect_contains "url = \"http://127.0.0.1:$docker_port/mcp\"" "automatic Codex config uses the active custom Docker port"
  expect_not_contains "$server_url" "automatic Codex config does not prefer an inactive server env"
  expect_not_contains "bearer_token_env_var" "automatic Docker Codex config requires no bearer token"

  capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" codex-config local
  expect_status 0 "explicit local Codex config reads active Docker state"
  expect_contains "url = \"http://127.0.0.1:$docker_port/mcp\"" "explicit local Codex config uses the active custom Docker port"
  expect_not_contains "$server_url" "explicit local Codex config ignores the server env"

  capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" codex-config server
  expect_status 0 "explicit server Codex config reads the validated server env"
  expect_contains "url = \"$server_url/mcp\"" "explicit server Codex config uses and normalizes the server URL"
  expect_contains "bearer_token_env_var" "explicit server Codex config requires the bearer-token environment variable"
  expect_not_contains "$SENSITIVE_TOKEN" "explicit server Codex config does not reveal the stored token"

  printf 'local\n' >"$run_dir/mode"
  printf '%s\n' "$local_port" >"$run_dir/api-port"
  printf 'http://127.0.0.1:%s\n' "$local_port" >"$run_dir/url"
  printf '\n' >"$run_dir/env-file"

  capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" codex-config auto
  expect_status 0 "automatic Codex config reads active native-local state"
  expect_contains "url = \"http://127.0.0.1:$local_port/mcp\"" "automatic Codex config uses the active custom native port"
  expect_not_contains "$server_url" "automatic native Codex config still ignores the inactive server env"

  capture env DESIGNER_RUNTIME_DIR="$runtime" bash "$LAUNCHER" codex-config local
  expect_status 0 "explicit local Codex config reads active native-local state"
  expect_contains "url = \"http://127.0.0.1:$local_port/mcp\"" "explicit local Codex config uses the active custom native port"
}

run_log_selection_regression_test() {
  local runtime="$TMP_ROOT/log-selection-runtime"
  local env_dir="$runtime/env"
  local run_dir="$runtime/run"
  local log_dir="$runtime/logs"
  local docker_env="$env_dir/docker.env"
  local mutation_log="$TMP_ROOT/log-selection-mutations.log"
  local stale_marker="STALE_NATIVE_LOG_MUST_NOT_WIN"
  local docker_marker="ACTIVE_DOCKER_LOG_SELECTED"

  mkdir -p "$env_dir" "$run_dir" "$log_dir"
  {
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=55604\n'
    printf 'PUBLIC_BASE_URL=http://127.0.0.1:55604\n'
    printf 'AUTH_MODE=none\n'
    printf 'DESIGNER_TOKEN=\n'
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$docker_env"
  chmod 600 "$docker_env"
  printf 'docker\n' >"$run_dir/mode"
  printf '55604\n' >"$run_dir/api-port"
  printf '0\n' >"$run_dir/web-port"
  printf 'http://127.0.0.1:55604\n' >"$run_dir/url"
  printf '%s\n' "$docker_env" >"$run_dir/env-file"
  printf '%s\n' "$stale_marker" >"$log_dir/local.log"

  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_DOCKER_LOG_OUTPUT="$docker_marker" \
    bash "$LAUNCHER" logs
  expect_status 0 "logs succeeds for active Docker state with a stale local log"
  expect_contains "$docker_marker" "logs selects the active Docker container output"
  expect_not_contains "$stale_marker" "logs ignores a stale native log while Docker mode is active"
  expect_absent "$mutation_log" "reading active Docker logs performs no Compose mutation"
}

run_gnu_stat_permission_regression_test() {
  local runtime="$TMP_ROOT/gnu-stat-runtime"
  local env_dir="$runtime/env"
  local server_env="$env_dir/server.env"
  local stat_bin="$TMP_ROOT/fake GNU stat/bin"
  local stat_log="$TMP_ROOT/fake-gnu-stat-calls.log"
  local mutation_log="$TMP_ROOT/gnu-stat-start-mutations.log"
  local server_url="https://gnu-stat.example.test"
  local checksum_before checksum_after

  mkdir -p "$env_dir" "$stat_bin"
  cat >"$stat_bin/stat" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -c)
    if [ -n "${DESIGNER_TEST_STAT_LOG:-}" ]; then
      printf 'gnu-c %s\n' "$*" >>"$DESIGNER_TEST_STAT_LOG"
    fi
    printf '600\n'
    exit 0
    ;;
  -f)
    if [ -n "${DESIGNER_TEST_STAT_LOG:-}" ]; then
      printf 'bsd-f %s\n' "$*" >>"$DESIGNER_TEST_STAT_LOG"
    fi
    # GNU stat may accept an unknown BSD-style option shape and emit text that
    # is nonempty but is not a permission mode. BSD-first probing is unsafe.
    printf 'misleading GNU stat output for BSD format\n'
    exit 0
    ;;
esac
exit 2
EOF
  chmod +x "$stat_bin/stat"

  {
    printf 'DESIGNER_SERVER_ACCESS=proxy\n'
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=55605\n'
    printf 'PUBLIC_BASE_URL=%s\n' "$server_url"
    printf 'AUTH_MODE=trusted-header\n'
    printf 'DESIGNER_TOKEN=%s\n' "$SENSITIVE_TOKEN"
    printf 'FORMASPEC_PROXY_SECRET=%s\n' "$SENSITIVE_PROXY_SECRET"
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$server_env"
  chmod 600 "$server_env"
  checksum_before="$(cksum "$server_env")"

  capture env \
    PATH="$stat_bin:$MOCK_PATH" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_STAT_LOG="$stat_log" \
    bash "$LAUNCHER" codex-config server
  expect_status 0 "explicit server Codex config accepts GNU stat mode 600"
  expect_contains "url = \"$server_url/mcp\"" "GNU-stat Codex config emits the validated server URL"
  expect_not_contains "$SENSITIVE_TOKEN" "GNU-stat Codex config does not reveal the stored token"
  expect_file_contains "$stat_log" "gnu-c" "server permission validation probes GNU stat syntax first"
  expect_file_not_contains "$stat_log" "bsd-f" "server permission validation avoids misleading BSD stat output on GNU"

  capture env \
    PATH="$stat_bin:$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_STAT_LOG="$stat_log" \
    DESIGNER_TEST_MUTATION_LOG="$mutation_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --dry-run start server --no-build
  expect_status 0 "dry-run server start accepts GNU stat mode 600"
  expect_contains "up -d" "GNU-stat dry-run server start reaches the Compose preview"
  expect_not_contains "$SENSITIVE_TOKEN" "GNU-stat dry-run server start does not reveal the token"
  expect_absent "$mutation_log" "GNU-stat dry-run server start performs no Compose mutation"
  expect_absent "$runtime/run" "GNU-stat dry-run server start creates no runtime state"
  expect_file_not_contains "$stat_log" "bsd-f" "server start also avoids BSD-first stat probing on GNU"
  checksum_after="$(cksum "$server_env")"
  expect_equal "$checksum_before" "$checksum_after" "GNU-stat validation leaves server.env unchanged"
}

run_restart_regression_test() {
  local runtime="$TMP_ROOT/restart-runtime"
  local env_dir="$runtime/env"
  local run_dir="$runtime/run"
  local docker_env="$env_dir/docker.env"
  local server_env="$env_dir/server.env"
  local compose_log="$TMP_ROOT/restart-compose.log"
  local custom_port=55431
  local custom_url="http://127.0.0.1:$custom_port"

  mkdir -p "$env_dir" "$run_dir"
  {
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=%s\n' "$custom_port"
    printf 'PUBLIC_BASE_URL=%s\n' "$custom_url"
    printf 'AUTH_MODE=none\n'
    printf 'DESIGNER_TOKEN=\n'
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$docker_env"
  {
    printf 'DESIGNER_SERVER_ACCESS=proxy\n'
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=55432\n'
    printf 'PUBLIC_BASE_URL=https://wrong-env.example.test\n'
    printf 'AUTH_MODE=trusted-header\n'
    printf 'DESIGNER_TOKEN=%s\n' "$SENSITIVE_TOKEN"
    printf 'FORMASPEC_PROXY_SECRET=%s\n' "$SENSITIVE_PROXY_SECRET"
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$server_env"
  chmod 600 "$docker_env" "$server_env"
  printf 'docker\n' >"$run_dir/mode"
  printf '%s\n' "$custom_port" >"$run_dir/api-port"
  printf '0\n' >"$run_dir/web-port"
  printf '%s\n' "$custom_url" >"$run_dir/url"
  printf '%s\n' "$docker_env" >"$run_dir/env-file"

  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$runtime" \
    DESIGNER_TEST_MUTATION_LOG="$compose_log" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open restart
  expect_status 0 "Docker restart with a recorded non-default port exits successfully"
  expect_file_contains "$compose_log" "--env-file $docker_env -f $PROJECT_ROOT/docker-compose.yml down" "restart stops Compose with the recorded Docker env"
  expect_file_contains "$compose_log" "--env-file $docker_env -f $PROJECT_ROOT/docker-compose.yml up -d" "restart starts Compose with the recorded Docker env"
  expect_file_not_contains "$compose_log" "--env-file $server_env" "restart does not select a different server env"
  expect_equal "docker" "$(cat "$run_dir/mode" 2>/dev/null || true)" "restart preserves Docker mode"
  expect_equal "$custom_port" "$(cat "$run_dir/api-port" 2>/dev/null || true)" "restart preserves the non-default API port"
  expect_equal "$custom_url" "$(cat "$run_dir/url" 2>/dev/null || true)" "restart preserves the non-default URL"
  expect_equal "$docker_env" "$(cat "$run_dir/env-file" 2>/dev/null || true)" "restart records the same Docker env file"
  expect_file_contains "$docker_env" "PORT=$custom_port" "restart rewrites Docker config with the recorded port"
  expect_file_contains "$docker_env" "PUBLIC_BASE_URL=$custom_url" "restart rewrites Docker config with the recorded URL"
}

run_runtime_alignment_regression_tests() {
  local fallback_runtime="$TMP_ROOT/doctor-api-port-runtime"
  local fallback_curl_log="$TMP_ROOT/doctor-api-port-curl.log"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$fallback_runtime" \
    DESIGNER_TEST_CURL_LOG="$fallback_curl_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor local
  expect_status 1 "doctor without runtime state reports unavailable services"
  expect_file_contains "$fallback_curl_log" "http://127.0.0.1:4310/health/ready" "doctor defaults readiness to the API port"
  expect_file_not_contains "$fallback_curl_log" "http://127.0.0.1:4311/health/ready" "doctor never mistakes the web port for the API port"

  local unowned_runtime="$TMP_ROOT/unowned-native-runtime"
  local existing_port=55435
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$unowned_runtime" \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port "$existing_port"
  expect_status 1 "native startup rejects an arbitrary healthy process"
  expect_contains "Refusing to adopt an arbitrary process" "native startup explains that a healthy port is not sufficient ownership proof"
  expect_absent "$unowned_runtime/run/mode" "native startup does not record a mode for an arbitrary healthy process"
  expect_absent "$unowned_runtime/run/pid" "native startup does not record a PID for an arbitrary healthy process"

  local existing_runtime="$TMP_ROOT/existing-native-runtime"
  mkdir -p "$existing_runtime/run"
  printf 'local\n' >"$existing_runtime/run/mode"
  printf '%s\n' "$existing_port" >"$existing_runtime/run/api-port"
  printf '%s\n' "$$" >"$existing_runtime/run/pid"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$existing_runtime" \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_TEST_PS_COMMAND="bash $LAUNCHER _run-native prod $existing_port 4311" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port "$existing_port"
  expect_status 0 "already-healthy owned native startup exits successfully"
  expect_contains "managed local runtime is already running" "native startup recognizes only its owned managed process"
  expect_equal "local" "$(cat "$existing_runtime/run/mode" 2>/dev/null || true)" "owned native startup preserves local mode"
  expect_equal "$existing_port" "$(cat "$existing_runtime/run/api-port" 2>/dev/null || true)" "owned native startup preserves its non-default API port"

  local competing_dev_runtime="$TMP_ROOT/native-start-dev-guard"
  mkdir -p "$competing_dev_runtime/run"
  printf 'dev\n' >"$competing_dev_runtime/run/mode"
  printf '55450\n' >"$competing_dev_runtime/run/api-port"
  printf '%s\n' "$$" >"$competing_dev_runtime/run/pid"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$competing_dev_runtime" \
    DESIGNER_TEST_PS_COMMAND="bash $LAUNCHER _run-native dev 55450 55451" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port 55452
  expect_status 1 "native startup refuses an already-active managed development process"
  expect_contains "managed dev FormaSpec runtime is already active" "native startup reports the competing managed development process"
  expect_equal "dev" "$(cat "$competing_dev_runtime/run/mode" 2>/dev/null || true)" "native startup preserves the competing development mode"

  local locked_runtime="$TMP_ROOT/native-start-transition-lock"
  mkdir -p "$locked_runtime/run/launcher.lock"
  printf '%s\n' "$$" >"$locked_runtime/run/launcher.lock/pid"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$locked_runtime" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port 55453
  expect_status 1 "native startup refuses a concurrent runtime transition"
  expect_contains "Another launcher command is running" "runtime transition lock prevents two starts from passing conflict checks"
  expect_absent "$locked_runtime/run/mode" "concurrent native startup writes no runtime mode"

  local guarded_runtime="$TMP_ROOT/native-start-docker-guard"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$guarded_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_DOCKER_PROJECT_RUNNING=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port 55436
  expect_status 1 "native startup refuses a running Docker workspace"
  expect_contains "separate data store" "native startup explains why the running Docker workspace is unsafe"
  expect_contains "start docker" "native startup gives the supported Docker continuation"
  expect_absent "$guarded_runtime/run/mode" "native startup guard fails before writing runtime mode"

  local paused_runtime="$TMP_ROOT/native-start-paused-docker-guard"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$paused_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_DOCKER_PROJECT_STATE=paused \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start local --port 55439
  expect_status 1 "native startup refuses a paused Docker workspace"
  expect_contains "already active" "paused Docker containers are treated as an active competing runtime"
  expect_absent "$paused_runtime/run/mode" "paused Docker guard fails before writing runtime mode"

  local guarded_dev_runtime="$TMP_ROOT/dev-start-docker-guard"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$guarded_dev_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_DOCKER_PROJECT_STATE=restarting \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open dev --api-port 55437 --web-port 55438 --skip-setup
  expect_status 1 "development startup refuses a restarting Docker workspace"
  expect_contains "separate data store" "development startup explains why the restarting Docker workspace is unsafe"
  expect_absent "$guarded_dev_runtime/run/mode" "restarting Docker guard fails before writing development mode"

  local docker_guard_runtime="$TMP_ROOT/docker-start-native-guard"
  local docker_guard_log="$TMP_ROOT/docker-start-native-guard.log"
  mkdir -p "$docker_guard_runtime/run"
  printf 'dev\n' >"$docker_guard_runtime/run/mode"
  printf '55440\n' >"$docker_guard_runtime/run/api-port"
  printf '%s\n' "$$" >"$docker_guard_runtime/run/pid"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$docker_guard_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_PS_COMMAND="bash $LAUNCHER _run-native dev 55440 55441" \
    DESIGNER_TEST_MUTATION_LOG="$docker_guard_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" --no-open start docker --port 55442 --no-build
  expect_status 1 "Docker startup refuses an owned development runtime"
  expect_contains "managed dev FormaSpec runtime" "Docker startup reports the competing managed native mode"
  expect_file_not_contains "$docker_guard_log" "docker compose" "Docker startup refuses before mutating Compose"

  local server_guard_runtime="$TMP_ROOT/server-start-native-guard"
  local server_guard_log="$TMP_ROOT/server-start-native-guard.log"
  mkdir -p "$server_guard_runtime/run" "$server_guard_runtime/env"
  printf 'local\n' >"$server_guard_runtime/run/mode"
  printf '55443\n' >"$server_guard_runtime/run/api-port"
  printf '%s\n' "$$" >"$server_guard_runtime/run/pid"
  {
    printf 'DESIGNER_SERVER_ACCESS=ssh\n'
    printf 'APP_MODE=local\n'
    printf 'FORMASPEC_CONTAINER_LOCAL=true\n'
    printf 'BIND_ADDRESS=127.0.0.1\n'
    printf 'PORT=55444\n'
    printf 'PUBLIC_BASE_URL=http://127.0.0.1:55444\n'
    printf 'AUTH_MODE=none\n'
    printf 'DESIGNER_TOKEN=\n'
    printf 'TRUSTED_USER_HEADER=x-designer-user\n'
    printf 'MAX_UPLOAD_BYTES=5242880\n'
  } >"$server_guard_runtime/env/server.env"
  chmod 600 "$server_guard_runtime/env/server.env"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$server_guard_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_PS_COMMAND="bash $LAUNCHER _run-native prod 55443 4311" \
    DESIGNER_TEST_MUTATION_LOG="$server_guard_log" \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" start server --no-build
  expect_status 1 "server startup refuses an owned local runtime"
  expect_contains "managed local FormaSpec runtime" "server startup reports the competing managed native mode"
  expect_file_not_contains "$server_guard_log" "docker compose" "server startup refuses before mutating Compose"

  local mismatch_runtime="$TMP_ROOT/doctor-runtime-mismatch"
  mkdir -p "$mismatch_runtime/run"
  printf 'docker\n' >"$mismatch_runtime/run/mode"
  printf '4310\n' >"$mismatch_runtime/run/api-port"
  printf '%s\n' '{"schemaVersion":1,"pid":123,"url":"http://127.0.0.1:4312","instanceId":"bridge-runtime-mismatch","upstreamMcpUrl":"http://127.0.0.1:4320/mcp"}' >"$mismatch_runtime/run/formaspec-bridge.json"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$mismatch_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor docker
  expect_status 1 "doctor rejects a healthy bridge targeting another runtime"
  expect_contains "Codex runtime mismatch" "doctor explains the UI and bridge runtime mismatch"
  expect_contains "http://127.0.0.1:4320/mcp" "doctor reports the mismatched bridge upstream"
  expect_contains "start docker" "doctor keeps a recorded Docker workspace on its existing data store"
  expect_not_contains "start local' and then rerun doctor" "doctor never recommends a separate local store for a recorded Docker runtime"

  local healthy_docker_runtime="$TMP_ROOT/doctor-healthy-docker-without-host-node"
  mkdir -p "$healthy_docker_runtime/run"
  printf 'docker\n' >"$healthy_docker_runtime/run/mode"
  printf '4310\n' >"$healthy_docker_runtime/run/api-port"
  printf '%s\n' '{"schemaVersion":1,"pid":123,"url":"http://127.0.0.1:4312","instanceId":"bridge-healthy-docker","upstreamMcpUrl":"http://127.0.0.1:4310/mcp"}' >"$healthy_docker_runtime/run/formaspec-bridge.json"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$healthy_docker_runtime" \
    DESIGNER_TEST_NODE_UNAVAILABLE=1 \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor auto
  expect_status 0 "recorded Docker doctor succeeds without host Node.js"
  expect_contains "Host Node.js and pnpm are not required for recorded Docker mode" "recorded Docker doctor explains its container runtime"
  expect_not_contains "Node.js 24+ is missing or too old" "recorded Docker doctor does not report a false host-Node failure"

  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$healthy_docker_runtime" \
    DESIGNER_TEST_NODE_UNAVAILABLE=1 \
    DESIGNER_TEST_DOCKER_DAEMON=ready \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor docker
  expect_status 0 "explicit Docker doctor succeeds without host Node.js"
  expect_contains "Host Node.js and pnpm are not required for Docker mode" "explicit Docker doctor reports host Node.js as unnecessary"
  expect_not_contains "Node.js 24+ is missing or too old" "explicit Docker doctor keeps host Node.js non-blocking"

  local native_without_node_runtime="$TMP_ROOT/doctor-native-without-host-node"
  mkdir -p "$native_without_node_runtime/run"
  printf '%s\n' '{"schemaVersion":1,"pid":123,"url":"http://127.0.0.1:4312","instanceId":"bridge-native-without-node","upstreamMcpUrl":"http://127.0.0.1:4310/mcp"}' >"$native_without_node_runtime/run/formaspec-bridge.json"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$native_without_node_runtime" \
    DESIGNER_TEST_NODE_UNAVAILABLE=1 \
    DESIGNER_TEST_CURL_OK=1 \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor local
  expect_status 1 "native local doctor still requires host Node.js"
  expect_contains "Node.js 24+ is missing or too old" "native local doctor retains the actionable Node.js failure"

  local stopped_docker_runtime="$TMP_ROOT/doctor-stopped-docker-runtime"
  mkdir -p "$stopped_docker_runtime/run"
  printf 'docker\n' >"$stopped_docker_runtime/run/mode"
  printf '4310\n' >"$stopped_docker_runtime/run/api-port"
  capture env \
    PATH="$MOCK_PATH" \
    HOME="$TMP_ROOT/home" \
    DESIGNER_RUNTIME_DIR="$stopped_docker_runtime" \
    DESIGNER_TEST_DOCKER_DAEMON=stopped \
    DESIGNER_NO_OPEN=1 \
    bash "$LAUNCHER" doctor auto
  expect_status 1 "doctor reports a stopped recorded Docker runtime"
  expect_contains "do not start local mode" "doctor keeps stopped Docker projects on their recorded data store"
  expect_not_contains "Start it or use '$LAUNCHER start local'" "doctor gives no contradictory local fallback for recorded Docker mode"
}

printf 'TAP version 13\n'

if [ ! -f "$LAUNCHER" ]; then
  printf 'Bail out! launcher not found at %s\n' "$LAUNCHER" >&2
  exit 1
fi

run_static_contract_tests
run_location_and_read_only_tests
run_dry_run_tests
run_cli_validation_tests
run_server_security_tests
run_codex_config_state_tests
run_log_selection_regression_test
run_gnu_stat_permission_regression_test
run_restart_regression_test
run_runtime_alignment_regression_tests

printf '# %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  exit 1
fi
