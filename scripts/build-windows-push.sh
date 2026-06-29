#!/usr/bin/env bash
# Cross-compile the Tauri app for Windows and push the exe to the SMB share.
# Run from repo root: ./scripts/build-windows-push.sh [--debug]
#
# Uses cargo-xwin directly (not `tauri build`) so we get just the exe without
# needing NSIS/WiX installers on macOS. Tauri's build.rs still runs and embeds
# the frontend assets from apps/tauri-client/dist.
set -euo pipefail

DEST="/Volumes/Video Editing/iracing-engineer.exe"
TARGET="x86_64-pc-windows-msvc"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_MODE="release"
CARGO_PROFILE_FLAG="--release"

if [[ "${1:-}" == "--debug" ]]; then
  BUILD_MODE="debug"
  CARGO_PROFILE_FLAG=""
  echo "ℹ  Debug build selected (faster compile, larger binary)"
fi

SRC_TAURI="$REPO_ROOT/apps/tauri-client/src-tauri"
EXE_PATH="$SRC_TAURI/target/$TARGET/$BUILD_MODE/iracing-engineer.exe"

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

# ── Build frontend ────────────────────────────────────────────────────────────

echo "→ Building frontend..."
cd "$REPO_ROOT"
npm run build -w apps/tauri-client

# ── Cross-compile Rust binary ─────────────────────────────────────────────────
# Use cargo-xwin directly. Tauri's build.rs reads CARGO_MANIFEST_DIR and picks
# up the dist/ assets from the distDir in tauri.conf.json automatically.

echo "→ Cross-compiling for Windows ($BUILD_MODE)..."
cd "$SRC_TAURI"
# shellcheck disable=SC2086
cargo xwin build $CARGO_PROFILE_FLAG --target "$TARGET"

# ── Push ──────────────────────────────────────────────────────────────────────

if [[ ! -f "$EXE_PATH" ]]; then
  echo ""
  echo "ERROR: Expected exe not found at:"
  echo "  $EXE_PATH"
  exit 1
fi

EXE_SIZE=$(du -sh "$EXE_PATH" | cut -f1)
echo "→ Copying $EXE_SIZE → $DEST"
cp "$EXE_PATH" "$DEST"

echo ""
echo "Done. Run on Windows:"
echo "  \\\\<server>\\<share>\\iracing-engineer.exe"
