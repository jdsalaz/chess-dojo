#!/bin/bash
# Run all project tests (Go + TypeScript).
# Mirrors .github/workflows/tests.yml for local use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILURES=0

run_step() {
    local label="$1"
    shift
    echo "=== $label ==="
    if "$@"; then
        echo "--- PASS: $label ---"
    else
        echo "--- FAIL: $label ---"
        FAILURES=$((FAILURES + 1))
    fi
    echo
}

# Go tests (backend)
if [ -f "$ROOT/backend/go.mod" ]; then
    run_step "Go tests (backend)" bash -c \
        "cd '$ROOT/backend' && stage=dev AWS_SDK_LOAD_CONFIG=true IS_TEST=true go test ./..."
fi

# Backend TypeScript tests (vitest)
if [ -f "$ROOT/backend/package.json" ]; then
    run_step "Backend vitest" bash -c \
        "cd '$ROOT/backend' && npm ci --ignore-scripts && npm run test"
fi

# Frontend unit tests (vitest)
if [ -f "$ROOT/frontend/package.json" ]; then
    run_step "Frontend vitest" bash -c \
        "cd '$ROOT/frontend' && npm ci && npm run test:unit"
fi

if [ "$FAILURES" -gt 0 ]; then
    echo "FAILED: $FAILURES step(s) failed"
    exit 1
fi

echo "ALL TESTS PASSED"
