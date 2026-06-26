#!/usr/bin/env bash
# Generates fixtures/query.wav from macOS text-to-speech.
# Requires: ffmpeg (brew install ffmpeg)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say -v Samantha "What's my gap to the car ahead" -o /tmp/query.aiff
ffmpeg -y -i /tmp/query.aiff -ar 16000 -ac 1 -c:a pcm_s16le "$SCRIPT_DIR/query.wav"
rm /tmp/query.aiff

echo "Generated: $SCRIPT_DIR/query.wav"
