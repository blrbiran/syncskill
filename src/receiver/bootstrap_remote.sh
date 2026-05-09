#!/usr/bin/env sh
set -eu

SYNC_ROOT="$HOME/.syncskill"
TEST_FILE="$SYNC_ROOT/.write_test_$$"

# Clean up test file on exit (handles interrupts)
trap 'rm -f "$TEST_FILE" 2>/dev/null' EXIT

# Create directory structure
mkdir -p "$SYNC_ROOT/skills"

# Ensure node is available
if ! command -v node >/dev/null 2>&1; then
  echo "syncskill: node is required on the remote host" >&2
  exit 1
fi

# Verify write permissions
if ! touch "$TEST_FILE" 2>/dev/null; then
  echo "syncskill: cannot write to $SYNC_ROOT" >&2
  exit 1
fi
