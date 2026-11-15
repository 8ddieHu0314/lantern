#!/bin/bash
# One-time setup. Needs the internet: it downloads about 6 GB of models.
# After this, Lantern runs with Wi-Fi off.
#
# Needs: an Apple Silicon Mac, Swift (Xcode or the command line tools), and uv (https://docs.astral.sh/uv/).

set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/4 Python environment"
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

echo "2/4 Bonsai 2 9B (3.6 GB)"
.venv/bin/hf download prism-ml/Ternary-Bonsai-2-9B-mlx-2bit --local-dir models/bonsai2-9b-mlx

echo "3/4 Building the speech service"
(cd speech && swift build -c release)

echo "4/4 Argmax models (WhisperKit, SpeakerKit, TTSKit), then a self-test"
LANTERN_MODELS_DIR="$PWD/models/argmax" speech/.build/release/LanternSpeech --selftest

echo "Done. Start Lantern with scripts/run_all.sh"
