#!/usr/bin/env bash
# Downloads whisper.cpp model files from Hugging Face.
# Total size: ~700MB (tiny: 75MB, base: 142MB, small: 466MB)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

for model in ggml-tiny.en.bin ggml-base.en.bin ggml-small.en.bin; do
  if [ -f "$DIR/$model" ]; then
    echo "Already exists: $model"
    continue
  fi
  echo "Downloading $model..."
  curl -L --progress-bar -o "$DIR/$model" "$BASE/$model"
done

echo "Done. Models in $DIR"
