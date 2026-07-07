#!/usr/bin/env bash
#
# C2 — "Direction is audible" (manual-test-plan.md §C2)
#
# Sets a chatty/assertive personality, fires the A1 driver query, shows the
# synthesized TEXT; waits 5s; then repeats with a terse personality. The chatty
# answer should read longer and more directive than the terse one.
#
# Usage:
#   ./c2-personality-compare.sh            # text only
#   ./c2-personality-compare.sh --audio    # also fetch + play each clip locally
#
# NOTE ON "the text that drove the audio": the hub exposes no HTTP endpoint for
# response text — /api/audio/:id returns MP3 bytes only, and nothing links an
# audioId back to its text. The spoken text is persisted to Postgres
# (engineer_events.response), so this script reads it from there rather than curl.
# Each query uses a UNIQUE sessionId so its audit row is unambiguous.
#
# NOTE ON --audio: the AudioClipRef (audioId/clipUrl) is only published on the
# Redis `voice:audio` channel, not stored in the DB — so for --audio we snoop
# that channel during each fire, then curl $HUB_URL/api/audio/<id> (within the
# 60s clip TTL) and play the MP3(s). A response is split into sentence clips, so
# multiple may play in order.
#
# Requires: redis-cli + psql on PATH, the hub running, the LLM reachable.
# For --audio: curl + an MP3 player (afplay/ffplay/mpg123, or set AUDIO_PLAYER).
#
set -euo pipefail

# ── Config (override via env) ─────────────────────────────────────────────────
REDISCLI=${REDISCLI:-redis-cli}                 # e.g. REDISCLI="redis-cli -h 192.168.1.155"
DATABASE_URL=${DATABASE_URL:-postgresql://iracing:iracing@localhost:5432/iracing_engineer}
HUB_URL=${HUB_URL:-http://localhost:5173}       # where /api/audio/<id> is served
TRANSCRIPT=${TRANSCRIPT:-do we pit this lap?}
POLL_TIMEOUT=${POLL_TIMEOUT:-30}                # seconds to wait for synthesis
AUDIO_PLAYER=${AUDIO_PLAYER:-}                  # override MP3 player command

PERSONALITY_KEY="hub:config:personality"
CHATTY='{"openness":3,"warmth":5,"energy":5,"conscientiousness":5,"assertiveness":5}'
TERSE='{"openness":3,"warmth":1,"energy":1,"conscientiousness":3,"assertiveness":1}'

run_id=$(date +%s)

# ── Arg parsing ───────────────────────────────────────────────────────────────
AUDIO=0
for arg in "$@"; do
  case "$arg" in
    --audio) AUDIO=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Kill any lingering voice:audio snooper on exit.
SUB_PID=""
cleanup() { [ -n "$SUB_PID" ] && kill "$SUB_PID" 2>/dev/null || true; }
trap cleanup EXIT

# ── Helpers ───────────────────────────────────────────────────────────────────
set_profile() {  # <label> <json>
  echo "▶ Setting $1 profile: $2"
  $REDISCLI SET "$PERSONALITY_KEY" "$2" >/dev/null
}

fire_query() {   # <sessionId>
  echo "▶ Firing A1 query (session=$1): \"$TRANSCRIPT\""
  $REDISCLI PUBLISH engineer:query \
    "{\"queryId\":\"c2q-$1\",\"transcript\":\"$TRANSCRIPT\",\"sessionId\":\"$1\",\"capturedAtMs\":0}" >/dev/null
}

show_response() {  # <sessionId>
  local session=$1 deadline=$(( $(date +%s) + POLL_TIMEOUT )) meta=""
  echo "  … waiting up to ${POLL_TIMEOUT}s for synthesis"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # Ready = row exists AND reached a terminal state (has text, or was skipped/errored).
    meta=$(psql "$DATABASE_URL" -At -c \
      "SELECT outcome||'|'||coalesce(latency_ms,0)||'|'||coalesce(length(response),0)
         FROM engineer_events
        WHERE session_id='$session' AND tier3_type='driver-query'
          AND (response IS NOT NULL OR outcome <> 'synthesized')
        ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || true)
    [ -n "$meta" ] && break
    sleep 1
  done

  if [ -z "$meta" ]; then
    echo "  ✗ No completed engineer_events row for session=$session within ${POLL_TIMEOUT}s."
    echo "    Check the hub is running and the LLM is reachable (see hub.jsonl)."
    return 1
  fi

  local outcome=${meta%%|*} rest=${meta#*|}
  local latency=${rest%%|*} len=${rest##*|}
  local text
  text=$(psql "$DATABASE_URL" -At -c \
    "SELECT coalesce(response,'(no text — outcome: '||outcome||')')
       FROM engineer_events
      WHERE session_id='$session' AND tier3_type='driver-query'
      ORDER BY created_at DESC LIMIT 1;" 2>/dev/null)

  echo "  outcome=${outcome}  latency=${latency}ms  length=${len} chars"
  echo "  ────────────────────────────────────────────────────────────"
  printf '  %s\n' "$text"
  echo "  ────────────────────────────────────────────────────────────"
}

# ── Audio (only used with --audio) ────────────────────────────────────────────
start_capture() {  # sets CAP_FILE + SUB_PID; snoops voice:audio (raw output when piped)
  CAP_FILE=$(mktemp -t c2cap.XXXXXX)
  $REDISCLI SUBSCRIBE voice:audio > "$CAP_FILE" 2>/dev/null &
  SUB_PID=$!
  sleep 0.3   # let the subscription establish before we publish
}

play_file() {  # <mp3>
  if [ -n "$AUDIO_PLAYER" ]; then $AUDIO_PLAYER "$1"; return; fi
  if   command -v afplay >/dev/null 2>&1; then afplay "$1"
  elif command -v ffplay >/dev/null 2>&1; then ffplay -autoexit -nodisp -loglevel quiet "$1"
  elif command -v mpg123 >/dev/null 2>&1; then mpg123 -q "$1"
  else echo "  (no MP3 player found — set AUDIO_PLAYER=… e.g. afplay)"; return 1; fi
}

play_captured_clips() {  # <capfile>
  # Pull driver-query clip paths (in publish = sentence order) from the snoop log.
  local paths i=0
  paths=$(grep '"tier3Type":"driver-query"' "$1" 2>/dev/null \
            | grep -oE '"clipUrl":"[^"]*"' | sed -E 's/.*:"([^"]*)"/\1/' || true)
  if [ -z "$paths" ]; then
    echo "  ♪ no voice:audio clips captured (hub not publishing, or they expired)"
    return 0
  fi
  echo "  ♪ playing $(printf '%s\n' "$paths" | grep -c . ) clip(s) from $HUB_URL"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    i=$((i+1))
    local tmp="${TMPDIR:-/tmp}/c2clip.${run_id}.${i}.mp3"
    if curl -fsS "${HUB_URL}${path}" -o "$tmp"; then
      play_file "$tmp" || true
    else
      echo "  ✗ fetch failed: ${HUB_URL}${path} (expired past 60s TTL?)"
    fi
    rm -f "$tmp"
  done <<< "$paths"
}

# ── One full query cycle ──────────────────────────────────────────────────────
run_query() {  # <sessionId>
  local session=$1
  [ "$AUDIO" -eq 1 ] && start_capture
  fire_query "$session"
  show_response "$session" || true
  if [ "$AUDIO" -eq 1 ]; then
    sleep 0.5                     # let the final clip land on voice:audio
    kill "$SUB_PID" 2>/dev/null || true; wait "$SUB_PID" 2>/dev/null || true; SUB_PID=""
    play_captured_clips "$CAP_FILE"
    rm -f "$CAP_FILE"
  fi
}

# ── 1–3: Chatty ───────────────────────────────────────────────────────────────
echo "=== C2: CHATTY / ASSERTIVE ==="
set_profile "chatty" "$CHATTY"
run_query "c2-chatty-${run_id}"

# ── 4: Wait ───────────────────────────────────────────────────────────────────
echo
echo "⏳ Waiting 5s before the terse profile…"
sleep 5
echo

# ── 5–7: Terse ────────────────────────────────────────────────────────────────
echo "=== C2: TERSE ==="
set_profile "terse" "$TERSE"
run_query "c2-terse-${run_id}"

echo
echo "✔ Done. Compare the two: chatty should be longer / more directive than terse."
