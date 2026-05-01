#!/usr/bin/env sh
set -eu

SYNC_ROOT="$HOME/.syncskill"
mkdir -p "$SYNC_ROOT/skills"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required on the remote host" >&2
  exit 1
fi
