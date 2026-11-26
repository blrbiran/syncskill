#!/usr/bin/env sh
set -eu

# Issue 422: accept the configured root (deployReceiver passes `remote_repo`) instead of assuming
# the default, so a non-default remote is provisioned and its write access is checked.
SYNC_ROOT="${1:-$HOME/.syncskill}"
TEST_FILE="$SYNC_ROOT/.write_test_$$"

# Clean up test file on exit (handles interrupts)
trap 'rm -f "$TEST_FILE" 2>/dev/null' EXIT

# Create directory structure
mkdir -p "$SYNC_ROOT/skills"

# Check the exact interpreter the controller will use for the receiver.
NODE_BIN="${SYNCSKILL_NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "E_RECEIVER_NODE_NOT_FOUND: $NODE_BIN is not executable on the remote host; set servers.<name>.node_bin or install Node.js 18+." >&2
  exit 1
fi
NODE_VERSION=$("$NODE_BIN" --version 2>&1) || {
  echo "E_RECEIVER_NODE_NOT_FOUND: $NODE_BIN could not report its version; set servers.<name>.node_bin to an executable Node.js binary." >&2
  exit 1
}
NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%.*}
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "E_RECEIVER_NODE_VERSION: $NODE_BIN reported an invalid version: $NODE_VERSION" >&2
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "E_RECEIVER_NODE_TOO_OLD: receiver requires Node.js 18 or newer; found $NODE_VERSION from $NODE_BIN" >&2
  exit 8
fi

# Verify write permissions
if ! touch "$TEST_FILE" 2>/dev/null; then
  echo "syncskill: cannot write to $SYNC_ROOT" >&2
  exit 1
fi
