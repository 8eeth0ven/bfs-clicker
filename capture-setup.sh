#!/usr/bin/env bash
# One-command bootstrap. Installs Python dependencies in this checkout only.
set -eo pipefail
# macOS ships Bash 3.2, whose nounset mode rejects an empty argument array.
# Preserve the inherited search order while supporting Finder-launched scripts.
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin:${HOME:-}/Library/Android/sdk/platform-tools"
CAPTURE_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$CAPTURE_REPO_DIR"
CAPTURE_DRY_RUN=0
CAPTURE_NO_INSTALL=0
CAPTURE_ANDROID=0
CAPTURE_CLEANUP=0
CAPTURE_STATE_ROOT="$CAPTURE_REPO_DIR/.capture-setup"
CAPTURE_NEXT_STATE=0
CAPTURE_ARGS=()
for CAPTURE_ARG in "$@"; do
  if [[ "$CAPTURE_NEXT_STATE" == 1 ]]; then
    CAPTURE_STATE_ROOT="$CAPTURE_ARG"
    CAPTURE_NEXT_STATE=0
    CAPTURE_ARGS+=("$CAPTURE_ARG")
    continue
  fi
  case "$CAPTURE_ARG" in
    --dry-run|-h|--help) CAPTURE_DRY_RUN=1; CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
    --no-install-deps) CAPTURE_NO_INSTALL=1 ;;
    --cleanup) CAPTURE_CLEANUP=1; CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
    --state-root) CAPTURE_NEXT_STATE=1; CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
    --state-root=*) CAPTURE_STATE_ROOT="${CAPTURE_ARG#*=}"; CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
    android|*.apk|*.APK) CAPTURE_ANDROID=1; CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
    *) CAPTURE_ARGS+=("$CAPTURE_ARG") ;;
  esac
done
if [[ "$CAPTURE_NEXT_STATE" == 1 ]]; then
  echo "--state-root 后需要一个专用目录。" >&2
  exit 2
fi
if [[ -L "$CAPTURE_REPO_DIR/.capture-setup" || -L "$CAPTURE_REPO_DIR/.capture-setup/venv" ]]; then
  echo "准备目录不能是符号链接。" >&2
  exit 2
fi
CAPTURE_PYTHON="${BFS_CAPTURE_PYTHON:-}"
if [[ -z "$CAPTURE_PYTHON" ]]; then
  for CAPTURE_CANDIDATE in python3.13 python3.12 python3; do
    if command -v "$CAPTURE_CANDIDATE" >/dev/null 2>&1 && "$CAPTURE_CANDIDATE" -c 'import sys;raise SystemExit(sys.version_info < (3,12))' 2>/dev/null; then
      CAPTURE_PYTHON="$(command -v "$CAPTURE_CANDIDATE")"
      break
    fi
  done
fi
if [[ -z "$CAPTURE_PYTHON" ]]; then
  if [[ "$CAPTURE_DRY_RUN" == 0 && "$CAPTURE_NO_INSTALL" == 0 ]] && command -v brew >/dev/null 2>&1; then
    echo "首次准备：安装 Python 3.13（Homebrew）……" >&2
    brew install python@3.13 >&2
    CAPTURE_PYTHON="$(brew --prefix python@3.13)/bin/python3.13"
  else
    echo "需要 Python ≥3.12。安装 Python 或 Homebrew 后重试；脚本不下载未知安装器。" >&2
    exit 2
  fi
fi
if [[ "$CAPTURE_DRY_RUN" == 1 || "$CAPTURE_NO_INSTALL" == 1 ]]; then
  PYTHONPATH="$CAPTURE_REPO_DIR/apk_tools${PYTHONPATH:+:$PYTHONPATH}" exec "$CAPTURE_PYTHON" -m apk_inventory.capture_setup "${CAPTURE_ARGS[@]}"
fi
CAPTURE_STATE_ROOT="$("$CAPTURE_PYTHON" -c 'from pathlib import Path;import sys;print(Path(sys.argv[1]).expanduser().absolute())' "$CAPTURE_STATE_ROOT")"
if [[ -L "$CAPTURE_STATE_ROOT" ]]; then
  echo "准备目录不能是符号链接。" >&2
  exit 2
fi
if [[ "$CAPTURE_ANDROID" == 1 ]] && ! command -v adb >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  echo "首次准备：安装 Android platform-tools……" >&2
  brew install --cask android-platform-tools >&2
fi
CAPTURE_ENV_DIR="$CAPTURE_REPO_DIR/.capture-setup/venv"
if [[ -L "$CAPTURE_REPO_DIR/.capture-setup" || -L "$CAPTURE_ENV_DIR" ]]; then
  echo "准备目录不能是符号链接。" >&2
  exit 2
fi
umask 077
if [[ ! -x "$CAPTURE_ENV_DIR/bin/python" ]]; then
  "$CAPTURE_PYTHON" -m venv "$CAPTURE_ENV_DIR"
fi
if [[ "$CAPTURE_CLEANUP" == 1 ]]; then
  # Recovery must not depend on contacting PyPI through a stale system proxy.
  exec "$CAPTURE_ENV_DIR/bin/python" -m apk_inventory.capture_setup "${CAPTURE_ARGS[@]}"
fi
if [[ -f "$CAPTURE_STATE_ROOT/latest.json" ]]; then
  "$CAPTURE_ENV_DIR/bin/python" -m apk_inventory.capture_setup --recover-only --state-root "$CAPTURE_STATE_ROOT" >&2
fi
CAPTURE_DEP_HASH="$("$CAPTURE_PYTHON" -c 'from pathlib import Path;import hashlib;print(hashlib.sha256(Path("apk_tools/pyproject.toml").read_bytes()).hexdigest())')"
CAPTURE_STAMP="$CAPTURE_ENV_DIR/.capture-dependencies"
if [[ ! -f "$CAPTURE_STAMP" ]] || [[ "$(cat "$CAPTURE_STAMP")" != "$CAPTURE_DEP_HASH" ]] || ! "$CAPTURE_ENV_DIR/bin/python" -c 'import apk_inventory,mitmproxy,qrcode' >/dev/null 2>&1; then
  echo "首次准备：安装项目依赖；后续运行将直接复用……" >&2
  "$CAPTURE_ENV_DIR/bin/python" -m pip install --disable-pip-version-check -q -e './apk_tools[setup]' >&2
  printf '%s\n' "$CAPTURE_DEP_HASH" > "$CAPTURE_STAMP"
fi
exec "$CAPTURE_ENV_DIR/bin/python" -m apk_inventory.capture_setup "${CAPTURE_ARGS[@]}"
