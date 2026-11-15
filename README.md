# Lantern

**For when the hospital goes dark.** An AI medical scribe that runs entirely on a MacBook with Wi-Fi off.

Cloud scribes like Abridge and Nuance DAX stop working when a hospital loses its network, which is
what happens in a ransomware attack: staff go back to paper, often for weeks. Lantern recreates the
scribe on the laptop itself. Record the visit, and it writes down who said what, drafts the clinical
note, and flags every medication for the clinician to verify. Nothing leaves the device.

Built for the Local AI Hackathon at Cornell (theme: Recreate).

## What it does

1. **Record** the visit in the browser.
2. **Transcribe** it and **label the speakers** (clinician, patient) on-device.
3. **Draft the note**: subjective, objective, assessment, plan, allergies, medications and a handoff.
4. **Check every medication and allergy** against the recording. A drug, dose or allergy that was
   not actually said is marked, and each one links to the transcript line it came from.
5. **Review, edit and print** the note.

## How it's built

```
Browser page (web/)
      │ audio, clicks
Python app (app/, :8000)
      ├──► Swift speech service (speech/, :8001)   Argmax: WhisperKit + SpeakerKit + TTSKit
      └──► Bonsai 2 9B via mlx-vlm (:8090)         PrismML ternary language model
```

| Piece | What it uses |
|---|---|
| Speech to text | Argmax WhisperKit (Whisper large-v3 turbo, Core ML) |
| Who is speaking | Argmax SpeakerKit (Pyannote, Core ML) |
| Text to speech | Argmax TTSKit (Qwen3-TTS, Core ML) |
| Note writing | PrismML Bonsai 2 9B (1.58-bit weights, about 3.5 GB) on MLX |
| Medication and allergy check | Plain code in `app/pipeline.py`: the model lists them, the code checks them against the transcript |

All servers bind to `127.0.0.1`. The page loads no fonts, scripts or styles from the web.

## Run it

Needs an Apple Silicon Mac, Swift (Xcode or the command line tools) and [uv](https://docs.astral.sh/uv/).

```sh
scripts/setup.sh      # once, online: downloads about 6 GB of models and builds the speech service
scripts/run_all.sh    # then turn Wi-Fi off if you like, and open http://localhost:8000
```

Tests for the transcript and medication logic:

```sh
cd app && ../.venv/bin/python -m unittest test_pipeline
```

## Safety

Lantern drafts; the clinician decides. The note uses only what was said in the visit, every
medication and allergy is flagged until someone ticks it as verified, and the printed note is
marked as a draft with a signature line. It is a hackathon prototype and has not been evaluated
for clinical use.
The sample visit in `web/sample-visit.wav` is synthetic speech, not a real patient.

## Team

Eddie Hu and Claudia Wong.
