"""Lantern app server: ties the browser UI to the speech service and Bonsai.

    GET  /                  the UI (web/)
    GET  /api/health        are the speech service and Bonsai up
    POST /api/transcribe    audio file as the body -> numbered turns with speaker roles
    POST /api/note          turns + roles -> structured note with checked medications
    GET  /api/visits        the visits saved on this laptop, newest first
    GET  /api/visits/export.txt             every saved note as one text file
    GET, PUT, DELETE /api/visits/{id}       one saved visit
    GET, PUT /api/visits/{id}/audio         its recording

Everything listens on 127.0.0.1 and nothing leaves the laptop.
"""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import llm
from visits import VisitStore
from pipeline import (
    Medication,
    Segment,
    Turn,
    assign_roles,
    check_allergies,
    check_medications,
    find_source,
    format_transcript,
    merge_turns,
)

SPEECH_URL = os.environ.get("LANTERN_SPEECH_URL", "http://127.0.0.1:8001")
DATA_DIR = Path(os.environ.get("LANTERN_DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
store = VisitStore(DATA_DIR / "visits")
# The sections whose sentences are each traced back to the recording.
SOURCED_SECTIONS = ("subjective", "objective", "assessment", "plan")
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

    sections = {name: _strings(raw.get(name)) for name in SOURCED_SECTIONS}
    return {
        "note": {
            "chief_complaint": str(raw.get("chief_complaint") or "").strip(),
            **sections,
            "allergies": _strings(raw.get("allergies")),
            "handoff": str(raw.get("handoff") or "").strip(),
        },
        # One entry per sentence, in the same order as the section's sentences.
        "sources": {name: [find_source(sentence, body.turns) for sentence in sections[name]] for name in SOURCED_SECTIONS},
        "medications": check_medications(_medications(raw.get("medications")), body.turns),
        "allergies": check_allergies(_strings(raw.get("allergies")), body.turns),
        "seconds": round(time.monotonic() - started, 1),
    }


@contextmanager
def _visit_errors():
    """Turn a bad id or a missing visit into a clear answer for the page."""
    try:
        yield
    except ValueError as error:
        raise HTTPException(400, "That is not a visit id.") from error
    except KeyError as error:
        raise HTTPException(404, "That visit is not saved on this laptop.") from error


@app.get("/api/visits")
def list_visits():
    return {"visits": store.summaries()}


@app.get("/api/visits/export.txt")
def export_visits():
    name = f"lantern-notes-{time.strftime('%Y%m%d-%H%M')}.txt"
    return PlainTextResponse(store.export_text(), headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/visits/{visit_id}")
def get_visit(visit_id: str):
    with _visit_errors():
        return store.load(visit_id)


@app.put("/api/visits/{visit_id}")
async def save_visit(visit_id: str, record: dict):
    with _visit_errors():
        store.save(visit_id, record)
    return {"saved": visit_id}


@app.delete("/api/visits/{visit_id}")
def delete_visit(visit_id: str):
    with _visit_errors():
        store.delete(visit_id)
    return {"deleted": visit_id}


@app.put("/api/visits/{visit_id}/audio")
async def save_visit_audio(visit_id: str, request: Request):
    audio = await request.body()
    with _visit_errors():
        store.save_audio(visit_id, audio)
    return {"saved": visit_id}


@app.get("/api/visits/{visit_id}/audio")
def get_visit_audio(visit_id: str):
    with _visit_errors():
        path = store.audio_path(visit_id)
    if path is None:
        raise HTTPException(404, "This visit has no recording saved.")
    return FileResponse(path, media_type="audio/wav")


class FreshStaticFiles(StaticFiles):
    """Serves the page with "no-cache", so the browser checks each file is current before using it.

    Without it the browser keeps running an old app.js after the file changes.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", FreshStaticFiles(directory=WEB_DIR, html=True), name="web")
