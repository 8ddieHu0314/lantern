"""Pure steps between the speech service and the note: turns, roles, and medication checks.

Nothing here talks to a model or the network, so it is all unit-tested in test_pipeline.py.
"""

from __future__ import annotations

import json
import re

from pydantic import BaseModel

CLINICIAN = "clinician"
PATIENT = "patient"
OTHER = "other"

UNKNOWN_SPEAKER = -1


class Segment(BaseModel):
    """One labeled stretch of speech, as the speech service returns it."""

    speaker: int
    start: float
    end: float
    text: str


class Turn(BaseModel):
    """Consecutive segments from one speaker. `id` is the line number the note cites."""

    id: int
    speaker: int
    start: float
    end: float
    text: str


class Medication(BaseModel):
    name: str
    dose: str = ""
    line: int = 0


class CheckedMedication(Medication):
    """A medication the model listed, checked against what was actually said."""

    name_heard: bool
    dose_heard: bool
    line_text: str = ""


def merge_turns(segments: list[Segment]) -> list[Turn]:
    """Join consecutive segments from the same speaker into numbered turns.

    A segment with no speaker label joins the turn before it, since a short
    unlabeled stretch is almost always the tail of whoever was just talking.
    """
    turns: list[Turn] = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        same_speaker = turns and (
            segment.speaker == turns[-1].speaker or segment.speaker == UNKNOWN_SPEAKER
        )
        if same_speaker:
            last = turns[-1]
            last.text = f"{last.text} {text}"
            last.end = max(last.end, segment.end)
        else:
            turns.append(
                Turn(
                    id=len(turns) + 1,
                    speaker=segment.speaker,
                    start=segment.start,
                    end=segment.end,
                    text=text,
                )
            )
    return turns


def assign_roles(turns: list[Turn]) -> dict[int, str]:
    """Guess who is the clinician: the speaker who asks the most questions.

    Ties go to whoever spoke first. The next most talkative speaker is the
    patient and anyone else is "other". The UI lets the user swap a wrong guess.
    """
    speakers: list[int] = []
    questions: dict[int, int] = {}
    words: dict[int, int] = {}
    for turn in turns:
        if turn.speaker not in questions:
            speakers.append(turn.speaker)
            questions[turn.speaker] = 0
            words[turn.speaker] = 0
        questions[turn.speaker] += turn.text.count("?")
        words[turn.speaker] += len(turn.text.split())

    if not speakers:
        return {}

    clinician = max(speakers, key=lambda s: (questions[s], -speakers.index(s)))
    roles = {clinician: CLINICIAN}
    rest = [s for s in speakers if s != clinician]
    if rest:
        patient = max(rest, key=lambda s: (words[s], -speakers.index(s)))
        roles[patient] = PATIENT
        for speaker in rest:
            roles.setdefault(speaker, OTHER)
    return roles


def format_transcript(turns: list[Turn], roles: dict[int, str]) -> str:
    """The transcript as the model sees it: `[3] PATIENT: I slipped on the ice.`"""
    lines = []
    for turn in turns:
        role = roles.get(turn.speaker, OTHER).upper()
        lines.append(f"[{turn.id}] {role}: {turn.text}")
    return "\n".join(lines)


def extract_json(text: str) -> dict:
    """Parse the model's reply as a JSON object, tolerating code fences and stray prose."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("The model's reply did not contain a JSON object.") from None
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("The model's reply was JSON but not an object.")
    return parsed


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z]+", text.lower())


_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}


def number_values(text: str) -> set[float]:
    """Every number in the text as a value, whether written as digits or as words.

    "400 mg", "four hundred milligrams" and "four hundred and fifty" give
    {400}, {400} and {450}, so a dose can be compared however it was transcribed.
    """
    tokens = re.findall(r"\d+(?:\.\d+)?|[a-z]+", text.lower())
    values: set[float] = set()
    total = current = 0.0
    in_run = False
    i = 0

    def close_run():
        nonlocal total, current, in_run
        if in_run:
            values.add(total + current)
        total = current = 0.0
        in_run = False

    while i < len(tokens):
        token = tokens[i]
        if token[0].isdigit():
            close_run()
            values.add(float(token))
        elif token in _UNITS:
            current += _UNITS[token]
            in_run = True
        elif token == "hundred" and in_run:
            current = (current or 1) * 100
        elif token == "thousand" and in_run:
            total += (current or 1) * 1000
            current = 0.0
        elif token == "point" and in_run and i + 1 < len(tokens) and tokens[i + 1] in _UNITS:
            digits = ""
            while i + 1 < len(tokens) and tokens[i + 1] in _UNITS and _UNITS[tokens[i + 1]] < 10:
                digits += str(_UNITS[tokens[i + 1]])
                i += 1
            current += float(f"0.{digits}") if digits else 0.0
        elif token == "and" and in_run and i + 1 < len(tokens) and tokens[i + 1] in _UNITS:
            pass
        else:
            close_run()
        i += 1
    close_run()
    return values


def check_medications(medications: list[Medication], turns: list[Turn]) -> list[CheckedMedication]:
    """Check each listed medication against the transcript.

    `name_heard` is true when the drug name appears in the cited line (or, if the
    model cited the wrong line, anywhere in the transcript, in which case the line
    is corrected). `dose_heard` is true when every number in the dose was said in
    that line. When no line can be tied to the drug (its name was not heard and
    the cited line does not exist), the dose is checked against the whole
    transcript, so a dose that was said is not reported as missing. A drug or
    dose that was not heard is exactly what a clinician must catch, so the UI
    shows it differently from one that was.
    """
    by_id = {turn.id: turn for turn in turns}
    checked: list[CheckedMedication] = []
    for med in medications:
        name_words = [w for w in _words(med.name) if len(w) > 2]

        def says_name(turn: Turn) -> bool:
            spoken = set(_words(turn.text))
            return bool(name_words) and all(w in spoken for w in name_words)

        turn = by_id.get(med.line)
        if turn is None or not says_name(turn):
            turn = next((t for t in turns if says_name(t)), turn)

        name_heard = turn is not None and says_name(turn)
        dose_numbers = number_values(med.dose)
        searched = [turn] if turn is not None else turns
        said = {value for t in searched for value in number_values(t.text)}
        dose_heard = bool(dose_numbers) and dose_numbers <= said

        checked.append(
            CheckedMedication(
                name=med.name,
                dose=med.dose,
                line=turn.id if turn is not None else 0,
                name_heard=name_heard,
                dose_heard=dose_heard,
                line_text=turn.text if turn is not None else "",
            )
        )
    return checked
