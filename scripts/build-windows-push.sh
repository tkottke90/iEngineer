#!/usr/bin/env bash
# Cross-compile the Tauri app for Windows and push the exe to the SMB share.
# Run from repo root: ./scripts/build-windows-push.sh [--debug]
#
# Uses MinGW (x86_64-pc-windows-gnu) — no cargo-xwin or MSVC toolchain needed.
# --features custom-protocol embeds the Vite dist/ into the binary.
# pnpm build MUST run before cargo build or old frontend assets stay embedded.
set -euo pipefail

DEST="/Volumes/Video Editing/iracing-engineer.exe"
TARGET="x86_64-pc-windows-gnu"
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

if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
  echo ""
  echo "ERROR: MinGW not found. Install it first:"
  echo "  brew install mingw-w64"
  exit 1
fi

if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "  Adding Rust target $TARGET..."
  rustup target add "$TARGET"
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
# Must run before cargo build — assets are embedded into the binary via
# --features custom-protocol. Skipping this leaves old UI in the exe.

echo "→ Building frontend..."
cd "$REPO_ROOT/apps/tauri-client"
pnpm build

# ── Cross-compile Rust binary ─────────────────────────────────────────────────

echo "→ Cross-compiling for Windows ($BUILD_MODE)..."
cd "$SRC_TAURI"
# shellcheck disable=SC2086
cargo build $CARGO_PROFILE_FLAG --target "$TARGET" --features custom-protocol

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

# NOTE: STT (whisper.cpp) is NOT in this cross-build — it cannot cross-compile from
# macOS (missing target C headers + Vulkan SDK). Push-to-talk is disabled in this
# exe; everything else works. For PTT, build natively on Windows with:
#   cargo build --release --features "custom-protocol stt"   (needs the Vulkan SDK)
