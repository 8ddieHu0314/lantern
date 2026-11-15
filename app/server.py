"""Lantern app server: ties the browser UI to the speech service and Bonsai.

    GET  /                  the UI (web/)
    GET  /api/health        are the speech service and Bonsai up
    POST /api/transcribe    audio file as the body -> numbered turns with speaker roles
    POST /api/note          turns + roles -> structured note with checked medications

Everything listens on 127.0.0.1 and nothing leaves the laptop.
"""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import llm
from pipeline import (
    Medication,
    Segment,
    Turn,
    assign_roles,
    check_medications,
    format_transcript,
    merge_turns,
)

SPEECH_URL = os.environ.get("LANTERN_SPEECH_URL", "http://127.0.0.1:8001")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # trust_env=False: never route a localhost call through a system proxy.
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=5), trust_env=False)
    yield
    await app.state.http.aclose()


app = FastAPI(title="Lantern", lifespan=lifespan)


class NoteRequest(BaseModel):
    turns: list[Turn]
    roles: dict[int, str]


def _strings(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _medications(value) -> list[Medication]:
    meds = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict) and str(item.get("name", "")).strip():
            line = item.get("line")
            meds.append(
                Medication(
                    name=str(item["name"]).strip(),
                    dose=str(item.get("dose") or "").strip(),
                    line=line if isinstance(line, int) else 0,
                )
            )
    return meds


@app.get("/api/health")
async def health(request: Request):
    http: httpx.AsyncClient = request.app.state.http
    try:
        speech = (await http.get(f"{SPEECH_URL}/health", timeout=3)).status_code == 200
    except httpx.HTTPError:
        speech = False
    return {"speech": speech, "llm": await llm.is_up(http), "model": llm.LLM_MODEL}


@app.post("/api/transcribe")
async def transcribe(request: Request, speakers: int | None = 2):
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "No audio was sent.")
    http: httpx.AsyncClient = request.app.state.http
    params = {"speakers": speakers} if speakers else {}
    try:
        response = await http.post(
            f"{SPEECH_URL}/transcribe",
            params=params,
            content=audio,
            headers={"Content-Type": request.headers.get("content-type", "audio/wav")},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f"The speech service failed: {error.response.text[:300]}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, f"The speech service is not running at {SPEECH_URL}. Start it with scripts/run_all.sh.") from error

    result = response.json()
    turns = merge_turns([Segment(**segment) for segment in result["segments"]])
    if not turns:
        raise HTTPException(422, "No speech was found in the recording.")
    return {
        "duration": result["duration"],
        "turns": turns,
        "roles": assign_roles(turns),
        "timings": result["timings"],
    }


@app.post("/api/note")
async def note(body: NoteRequest, request: Request):
    if not body.turns:
        raise HTTPException(400, "The transcript is empty.")
    started = time.monotonic()
    try:
        raw = await llm.write_note(request.app.state.http, format_transcript(body.turns, body.roles))
    except llm.LLMError as error:
        raise HTTPException(502, str(error)) from error

    return {
        "note": {
            "chief_complaint": str(raw.get("chief_complaint") or "").strip(),
            "subjective": _strings(raw.get("subjective")),
            "objective": _strings(raw.get("objective")),
            "assessment": _strings(raw.get("assessment")),
            "plan": _strings(raw.get("plan")),
            "allergies": _strings(raw.get("allergies")),
            "handoff": str(raw.get("handoff") or "").strip(),
        },
        "medications": check_medications(_medications(raw.get("medications")), body.turns),
        "seconds": round(time.monotonic() - started, 1),
    }


class FreshStaticFiles(StaticFiles):
    """Serves the page with "no-cache", so the browser checks each file is current before using it.

    Without it the browser keeps running an old app.js after the file changes.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", FreshStaticFiles(directory=WEB_DIR, html=True), name="web")
