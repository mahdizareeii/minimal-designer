#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"
export CI=1

pnpm test:macos-pkg-evidence
pnpm release:evidence:generate
pnpm release:evidence:check
pnpm release:evidence:macos:generate
pnpm release:evidence:macos:verify
pnpm release:evidence:macos:gate
