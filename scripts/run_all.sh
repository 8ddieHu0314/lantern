#!/bin/bash
# Start Lantern: Bonsai (language model), the speech service, and the app.
# Everything listens on 127.0.0.1 only. Ctrl+C stops all three.
#
#   scripts/run_all.sh        then open http://localhost:8000

set -euo pipefail
cd "$(dirname "$0")/.."

LLM_PORT="${LANTERN_LLM_PORT:-8090}"
SPEECH_PORT="${LANTERN_SPEECH_PORT:-8001}"
APP_PORT="${LANTERN_APP_PORT:-8000}"
BONSAI="models/bonsai2-9b-mlx"
SPEECH_BIN="speech/.build/release/LanternSpeech"

[ -d "$BONSAI" ] || { echo "Bonsai is not downloaded. Run scripts/setup.sh first."; exit 1; }
[ -x "$SPEECH_BIN" ] || { echo "The speech service is not built. Run scripts/setup.sh first."; exit 1; }

mkdir -p logs
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Offline flags: never look for model updates on the network.
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

echo "Starting Bonsai on :$LLM_PORT"
.venv/bin/python -m mlx_vlm.server --host 127.0.0.1 --port "$LLM_PORT" --model "$BONSAI" > logs/bonsai.log 2>&1 &
pids+=($!)

echo "Starting the speech service on :$SPEECH_PORT"
LANTERN_SPEECH_PORT="$SPEECH_PORT" LANTERN_MODELS_DIR="$PWD/models/argmax" LANTERN_PRELOAD_TTS="${LANTERN_PRELOAD_TTS:-0}" \
  "$SPEECH_BIN" > logs/speech.log 2>&1 &
pids+=($!)

echo "Starting the app on :$APP_PORT"
(cd app && LANTERN_LLM_URL="http://127.0.0.1:$LLM_PORT" LANTERN_SPEECH_URL="http://127.0.0.1:$SPEECH_PORT" \
  ../.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port "$APP_PORT" > ../logs/app.log 2>&1) &
pids+=($!)

echo "Waiting for the models to load (about a minute)…"
for _ in $(seq 1 180); do
  if curl -sf "http://127.0.0.1:$SPEECH_PORT/health" > /dev/null && curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" > /dev/null; then
    echo "Lantern is ready: http://localhost:$APP_PORT"
    wait
    exit 0
  fi
  sleep 1
done
echo "Something did not start. Check logs/bonsai.log and logs/speech.log."
exit 1
