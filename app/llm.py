"""Bonsai 2 client: turns a labeled transcript into a structured clinical note.

Bonsai runs locally behind mlx_vlm.server, which speaks the OpenAI chat API.
"""

from __future__ import annotations

import os

import httpx

from pipeline import extract_json

LLM_URL = os.environ.get("LANTERN_LLM_URL", "http://127.0.0.1:8090")
LLM_MODEL = os.environ.get("LANTERN_LLM_MODEL", "models/bonsai2-9b-mlx")

_STRINGS = {"type": "array", "items": {"type": "string"}}

NOTE_SCHEMA = {
    "type": "object",
    "properties": {
        "chief_complaint": {"type": "string"},
        "subjective": _STRINGS,
        "objective": _STRINGS,
        "assessment": _STRINGS,
        "plan": _STRINGS,
        "allergies": _STRINGS,
        "medications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "dose": {"type": "string"},
                    "line": {"type": "integer"},
                },
                "required": ["name", "dose", "line"],
                "additionalProperties": False,
            },
        },
        "handoff": {"type": "string"},
    },
    "required": [
        "chief_complaint",
        "subjective",
        "objective",
        "assessment",
        "plan",
        "allergies",
        "medications",
        "handoff",
    ],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are a medical scribe. You turn the transcript of a clinical visit into a note \
for the clinician to review. The clinician is busy and the hospital's systems are down, so the note \
must be short, accurate and ready to print.

Use only what was said in the transcript. Never add a symptom, finding, diagnosis, drug or dose \
that nobody said. If a section has nothing in the transcript, leave it as an empty list. \
Write "the patient", never "he" or "she", unless the transcript states the patient's sex.

Reply with one JSON object with these fields:
- chief_complaint: the main reason for the visit, in a few words.
- subjective: what the patient reports (symptoms, how it happened, history), one short phrase each.
- objective: what the clinician observed or measured out loud (exam findings, vital signs).
- assessment: what the clinician said they think is going on. Do not make your own diagnosis.
- plan: what the clinician said will happen next (treatment, tests, follow-up).
- allergies: allergies the patient stated. If allergies were never discussed, leave this list empty; \
do not write "no known allergies" unless the patient said they have none.
- medications: every drug mentioned, whether the patient already takes it or the clinician is \
giving it. For each: the name, the dose exactly as spoken ("" if no dose was said), and the number \
of the transcript line where it was said.
- handoff: two sentences a colleague taking over this patient needs to hear. Here too, write \
"the patient", never "he" or "she".

Each transcript line starts with its number in brackets, like [4]."""

# PrismML's recommended sampling for Bonsai 2 with thinking off, with a lower
# temperature and no presence penalty: a note should repeat the transcript's words.
SAMPLING = {"temperature": 0.3, "top_p": 0.8, "top_k": 20}


class LLMError(RuntimeError):
    pass


async def chat(client: httpx.AsyncClient, messages: list[dict], *, max_tokens: int, schema: dict | None = None) -> str:
    payload = {"model": LLM_MODEL, "messages": messages, "max_tokens": max_tokens, **SAMPLING}
    if schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "clinical_note", "schema": schema, "strict": True},
        }
    try:
        response = await client.post(f"{LLM_URL}/v1/chat/completions", json=payload)
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise LLMError(f"Bonsai did not answer at {LLM_URL}: {error}") from error
    return response.json()["choices"][0]["message"]["content"] or ""


async def write_note(client: httpx.AsyncClient, transcript: str) -> dict:
    """Ask Bonsai for the note as a JSON object. Retries once if the reply does not parse."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Transcript:\n{transcript}\n\nWrite the note as JSON."},
    ]
    last_error: Exception | None = None
    for _ in range(2):
        reply = await chat(client, messages, max_tokens=1200, schema=NOTE_SCHEMA)
        try:
            return extract_json(reply)
        except ValueError as error:
            last_error = error
    raise LLMError(f"Bonsai's note could not be read: {last_error}")


async def is_up(client: httpx.AsyncClient) -> bool:
    try:
        response = await client.get(f"{LLM_URL}/v1/models", timeout=3)
        return response.status_code == 200
    except httpx.HTTPError:
        return False
