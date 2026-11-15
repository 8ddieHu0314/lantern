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


class Part(BaseModel):
    """One phrase inside a turn, with its place in the recording."""

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
    parts: list[Part] = []


class Medication(BaseModel):
    name: str
    dose: str = ""
    line: int = 0


class CheckedMedication(Medication):
    """A medication the model listed, checked against what was actually said."""

    name_heard: bool
    dose_heard: bool
    line_text: str = ""


class Source(BaseModel):
    """Where in the recording a sentence of the note came from. `line` is 0 when nothing matched."""

    line: int = 0
    start: float = 0
    end: float = 0
    quote: str = ""


class CheckedAllergy(BaseModel):
    """An allergy the model listed, checked against what was actually said."""

    name: str
    heard: bool
    line: int = 0
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
        part = Part(start=segment.start, end=segment.end, text=text)
        if same_speaker:
            last = turns[-1]
            last.text = f"{last.text} {text}"
            last.end = max(last.end, segment.end)
            last.parts.append(part)
        else:
            turns.append(
                Turn(
                    id=len(turns) + 1,
                    speaker=segment.speaker,
                    start=segment.start,
                    end=segment.end,
                    text=text,
                    parts=[part],
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


# Words that describe an allergy entry without naming what the patient is allergic to.
_ALLERGY_FILLER = {"allergy", "allergies", "allergic", "known", "none", "drug", "drugs", "and", "the", "reaction"}
_ALLERGY_WORDS = {"allergy", "allergies", "allergic"}


def check_allergies(allergies: list[str], turns: list[Turn]) -> list[CheckedAllergy]:
    """Check each listed allergy against the transcript.

    An allergy is `heard` when all of its words were said in one line, which is
    then the line it links to. An entry with no words of its own, such as
    "No known allergies", cannot be checked word for word: it counts as heard
    when allergies came up at all, and links to that line for the clinician to read.
    """
    spoken = [(turn, set(_words(turn.text))) for turn in turns]
    checked: list[CheckedAllergy] = []
    for name in allergies:
        words = {w for w in _words(name) if len(w) > 2} - _ALLERGY_FILLER
        if words:
            turn = next((t for t, said in spoken if words <= said), None)
        else:
            turn = next((t for t, said in spoken if said & _ALLERGY_WORDS), None)
        checked.append(
            CheckedAllergy(
                name=name,
                heard=turn is not None,
                line=turn.id if turn is not None else 0,
                line_text=turn.text if turn is not None else "",
            )
        )
    return checked


# Words too common to show where a sentence came from, plus the note's own vocabulary
# ("the patient reports"), which the people in the room never say.
_FILLER = set(
    "the and for with has have had was were are not but that this these those from about when will would "
    "your you his her their they she him its any some into than then there out per due also very "
    "patient clinician reports reported states stated denies notes noted".split()
)
_ENDINGS = ("ness", "ing", "ed", "es", "ly", "s")
_MAX_PHRASES = 3


def _stem(word: str) -> str:
    """Trim a common ending so "tenderness" meets "tender" and "hurts" meets "hurt"."""
    for ending in _ENDINGS:
        if word.endswith(ending) and len(word) - len(ending) >= 3:
            return word[: -len(ending)]
    return word


def _content(text: str) -> set[str]:
    return {_stem(w) for w in _words(text) if len(w) > 2 and w not in _FILLER}


def find_source(sentence: str, turns: list[Turn]) -> Source:
    """Trace a sentence of the note to the place in the recording that said it.

    Looks for the shortest run of up to three neighbouring phrases, inside one
    turn, that contains enough of the sentence's content words: at least half
    of them, and at least two unless the sentence only has one. If no run is
    enough but a whole turn is, the sentence points at that turn's best phrase.
    Otherwise the sentence has no source, which is how a line the model made up
    shows itself.

    This checks that the words were said, not that the sentence means the same
    thing, so it is a pointer for the clinician and not a proof.
    """
    wanted = _content(sentence)
    if not wanted:
        return Source()

    def found(text: str) -> int:
        return len(wanted & _content(text))

    def enough(count: int) -> bool:
        return count >= min(2, len(wanted)) and count * 2 >= len(wanted)

    best: tuple[int, int, float, Turn, list[Part]] | None = None
    whole: tuple[int, Turn] | None = None
    for turn in turns:
        parts = turn.parts or [Part(start=turn.start, end=turn.end, text=turn.text)]
        in_turn = found(turn.text)
        if whole is None or in_turn > whole[0]:
            whole = (in_turn, turn)
        for first in range(len(parts)):
            for size in range(1, _MAX_PHRASES + 1):
                run = parts[first : first + size]
                if len(run) < size:
                    break
                score = found(" ".join(part.text for part in run))
                # More of the sentence's words wins; on a tie the shorter run does.
                key = (score, -size, -(run[-1].end - run[0].start))
                if best is None or key > best[:3]:
                    best = (*key, turn, run)

    if best is None or whole is None:
        return Source()
    score, _, _, turn, run = best
    if not enough(score):
        if not enough(whole[0]):
            return Source()
        turn = whole[1]
        parts = turn.parts or [Part(start=turn.start, end=turn.end, text=turn.text)]
        run = [max(parts, key=lambda part: found(part.text))]
    return Source(line=turn.id, start=run[0].start, end=run[-1].end, quote=" ".join(part.text for part in run))
