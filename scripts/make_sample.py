"""Build web/sample-visit.wav: a mock visit spoken by two synthetic voices.

It gives the app a recording to demo and test with when nobody is around to talk.
The speech service must be running (scripts/run_all.sh). Nothing in it is real patient data.

    .venv/bin/python scripts/make_sample.py
"""

from __future__ import annotations

import io
import sys
import wave
from pathlib import Path

import httpx
import numpy as np

SPEECH_URL = "http://127.0.0.1:8001"
OUT = Path(__file__).resolve().parent.parent / "web" / "sample-visit.wav"

CLINICIAN, PATIENT = "aiden", "serena"

VISIT = [
    (CLINICIAN, "Hi, I'm Doctor Hu. What happened this morning?"),
    (PATIENT, "I slipped on the ice outside my apartment and landed on my right hand. My wrist hurts a lot."),
    (CLINICIAN, "Any numbness or tingling in your fingers?"),
    (PATIENT, "A little tingling in my thumb."),
    (CLINICIAN, "Do you take any medication, and do you have any allergies?"),
    (PATIENT, "I take lisinopril, ten milligrams every morning. And I'm allergic to penicillin."),
    (CLINICIAN, "Okay. There's swelling and tenderness over the right wrist. Capillary refill is under two seconds. This looks like a distal radius fracture."),
    (CLINICIAN, "We'll put it in a splint, keep it elevated, and get an x-ray as soon as imaging is back online. I'll give you ibuprofen, four hundred milligrams, for the pain."),
    (PATIENT, "Okay, thank you."),
]

PAUSE_SECONDS = 0.5


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data)) as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
        return samples, wav.getframerate()


def main() -> int:
    parts: list[np.ndarray] = []
    rate = 0
    with httpx.Client(timeout=600, trust_env=False) as client:
        for index, (voice, text) in enumerate(VISIT, start=1):
            print(f"[{index}/{len(VISIT)}] {voice}: {text}")
            response = client.post(f"{SPEECH_URL}/speak", json={"text": text, "voice": voice})
            response.raise_for_status()
            samples, rate = read_wav(response.content)
            parts.append(samples)
            parts.append(np.zeros(int(rate * PAUSE_SECONDS), dtype=np.int16))

    audio = np.concatenate(parts)
    with wave.open(str(OUT), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(audio.tobytes())
    print(f"Wrote {OUT} ({len(audio) / rate:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
