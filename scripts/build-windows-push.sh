#!/usr/bin/env bash
# Cross-compile the Tauri app for Windows and push the exe to the SMB share.
# Run from repo root: ./scripts/build-windows-push.sh [--debug]
set -euo pipefail

DEST="/Volumes/Video Editing/iracing-engineer.exe"
TARGET="x86_64-pc-windows-msvc"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_MODE="release"
TAURI_FLAGS="--bundles none"

if [[ "${1:-}" == "--debug" ]]; then
  BUILD_MODE="debug"
  TAURI_FLAGS="--bundles none --debug"
  echo "ℹ  Debug build selected (faster compile, larger binary)"
fi

EXE_PATH="$REPO_ROOT/apps/tauri-client/src-tauri/target/$TARGET/$BUILD_MODE/iracing-engineer.exe"

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "→ Checking prerequisites..."

if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "  Adding Rust target $TARGET..."
  rustup target add "$TARGET"
fi

if ! cargo xwin --version &>/dev/null 2>&1; then
  echo "  Installing cargo-xwin (Windows cross-compiler)..."
  cargo install cargo-xwin
fi

# ── SMB share check ───────────────────────────────────────────────────────────

SHARE_DIR="$(dirname "$DEST")"
if [[ ! -d "$SHARE_DIR" ]]; then
  echo ""
  echo "ERROR: SMB share not mounted at: $SHARE_DIR"
  echo "Mount it first in Finder (Go → Connect to Server) then re-run."
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────────────────

echo "→ Building frontend..."
cd "$REPO_ROOT"
npm run build -w apps/tauri-client

echo "→ Cross-compiling Tauri for Windows ($BUILD_MODE)..."
cd "$REPO_ROOT/apps/tauri-client"
# shellcheck disable=SC2086
npm run tauri build -- --target "$TARGET" $TAURI_FLAGS

# ── Push ──────────────────────────────────────────────────────────────────────

if [[ ! -f "$EXE_PATH" ]]; then
  echo ""
  echo "ERROR: Expected exe not found at:"
  echo "  $EXE_PATH"
  echo "Check build output above for the actual path."
  exit 1
fi

EXE_SIZE=$(du -sh "$EXE_PATH" | cut -f1)
echo "→ Copying $EXE_SIZE → $DEST"
cp "$EXE_PATH" "$DEST"

echo ""
echo "Done. Run on Windows:"
echo "  Z:\\iracing-engineer.exe   (or whatever drive letter the share maps to)"
