#!/usr/bin/env bash
set -euo pipefail
CAPTURE_COMMAND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$CAPTURE_COMMAND_DIR/capture-setup.sh" --interactive "$@"
