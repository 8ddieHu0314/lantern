"""Saved visits: one JSON file and one audio file per visit, in a folder on this laptop.

During an outage every note has to survive until the record system is back, so each
visit is written to disk as soon as its note is drafted and again whenever it is edited.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# A visit's id is the local time it started, like 20261115-015200. Being that strict
# also means an id can never point outside the visits folder.
_ID = re.compile(r"\d{8}-\d{6}")


class VisitStore:
    def __init__(self, folder: Path):
        self.folder = folder

    def _path(self, visit_id: str, suffix: str) -> Path:
        if not _ID.fullmatch(visit_id):
            raise ValueError(f"Not a visit id: {visit_id!r}")
        return self.folder / f"{visit_id}{suffix}"

    def save(self, visit_id: str, record: dict) -> None:
        path = self._path(visit_id, ".json")
        self.folder.mkdir(parents=True, exist_ok=True)
        # Write to a temporary file first, so a crash mid-save never leaves half a note.
        draft = path.with_suffix(".json.tmp")
        draft.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        draft.replace(path)

    def save_audio(self, visit_id: str, audio: bytes) -> None:
        path = self._path(visit_id, ".wav")
        self.folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(audio)

    def load(self, visit_id: str) -> dict:
        path = self._path(visit_id, ".json")
        if not path.exists():
            raise KeyError(visit_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def audio_path(self, visit_id: str) -> Path | None:
        path = self._path(visit_id, ".wav")
        return path if path.exists() else None

    def delete(self, visit_id: str) -> None:
        for suffix in (".json", ".wav"):
            self._path(visit_id, suffix).unlink(missing_ok=True)

    def _records(self) -> list[tuple[str, dict]]:
        """Every readable visit, oldest first. A damaged file is skipped."""
        found = []
        for path in sorted(self.folder.glob("*.json")) if self.folder.exists() else []:
            try:
                found.append((path.stem, json.loads(path.read_text(encoding="utf-8"))))
            except (OSError, ValueError):
                continue
        return found

    def summaries(self) -> list[dict]:
        """What the visits list shows, newest first."""
        return [
            {
                "id": visit_id,
                "created": record.get("created", ""),
                "title": (record.get("note") or {}).get("chief_complaint") or "Visit note",
                "handoff": (record.get("note") or {}).get("handoff", ""),
                "to_verify": sum(
                    not item.get("verified")
                    for item in [*record.get("medications", []), *record.get("allergies", [])]
                ),
            }
            for visit_id, record in reversed(self._records())
        ]

    def export_text(self) -> str:
        """Every note as one plain text, oldest first, to copy into the record system."""
        records = self._records()
        count = f"{len(records)} visit{'' if len(records) == 1 else 's'}"
        blocks = [f"LANTERN DOWNTIME NOTES · {count} · drafts until signed"]
        blocks += [f"{'=' * 60}\nVisit {visit_id}\n{'=' * 60}\n{record.get('text', '').strip()}" for visit_id, record in records]
        return "\n\n".join(blocks) + "\n"
