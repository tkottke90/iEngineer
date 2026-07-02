#!/usr/bin/env bash
# Downloads the Whisper base.en model used by the M5 push-to-talk STT (T041).
# ~142MB. The PTT pipeline loads it from WHISPER_MODEL_PATH, else ./models/ggml-base.en.bin
# (relative to the process cwd). See stt/whisper.rs.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
MODEL="ggml-base.en.bin"

if [ -f "$DIR/$MODEL" ]; then
  echo "Already exists: $MODEL"
else
  echo "Downloading $MODEL (~142MB)..."
  curl -L --progress-bar -o "$DIR/$MODEL" "$BASE/$MODEL"
fi

echo "Done. Model at $DIR/$MODEL"
echo "Set WHISPER_MODEL_PATH=$DIR/$MODEL if launching from a different working directory."
