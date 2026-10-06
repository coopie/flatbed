#!/usr/bin/env bash
# The gate before a merge: each implementation's checks, then the conformance suite against it.
# Run `scripts/check.sh` for everything, or name sections, such as `scripts/check.sh ts`.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_NO_WARNINGS=1

check_ts() {
  echo "== ts"
  (cd ts && pnpm install --frozen-lockfile --silent)
  (cd ts && pnpm exec tsc --noEmit -p tsconfig.json)
  for pkg in ts/packages/*/; do
    if compgen -G "$pkg*.test.ts" > /dev/null; then (cd "$pkg" && node --test "*.test.ts"); fi
  done
  node ts/packages/core/conformance.ts
}

check_python() {
  echo "== python"
  # The Python implementation fills this in: ruff, unittest, then its conformance runner.
  echo "not built yet"
}

check_rust() {
  echo "== rust"
  # The Rust implementation fills this in: cargo fmt --check, clippy, test, then its conformance runner.
  echo "not built yet"
}

sections=("$@")
if [ ${#sections[@]} -eq 0 ]; then sections=(ts python rust); fi
for section in "${sections[@]}"; do
  case "$section" in
    ts) check_ts ;;
    python) check_python ;;
    rust) check_rust ;;
    *) echo "Unknown section: $section" >&2; exit 2 ;;
  esac
done
echo "== all checks passed"
