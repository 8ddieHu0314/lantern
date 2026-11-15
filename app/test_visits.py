import tempfile
import unittest
from pathlib import Path

from visits import VisitStore


def record(title="Wrist pain", verified=(False, True), created="2026-11-15T01:52:00.000Z", text="NOTE TEXT"):
    return {
        "created": created,
        "note": {"chief_complaint": title, "handoff": "Fracture suspected."},
        "medications": [{"name": "ibuprofen", "verified": verified[0]}],
        "allergies": [{"name": "penicillin", "verified": verified[1]}],
        "text": text,
    }


class VisitStoreTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = VisitStore(Path(self.folder.name) / "visits")

    def test_a_saved_visit_can_be_loaded_back(self):
        self.store.save("20261115-015200", record())
        self.assertEqual(self.store.load("20261115-015200")["note"]["chief_complaint"], "Wrist pain")

    def test_saving_again_replaces_the_visit(self):
        self.store.save("20261115-015200", record(title="first"))
        self.store.save("20261115-015200", record(title="second"))
        self.assertEqual([v["title"] for v in self.store.summaries()], ["second"])

    def test_summaries_are_newest_first_and_count_what_is_left_to_verify(self):
        self.store.save("20261115-010500", record(title="Laceration", verified=(True, True)))
        self.store.save("20261115-015200", record(title="Wrist pain", verified=(False, False)))
        self.assertEqual(
            [(v["id"], v["title"], v["to_verify"]) for v in self.store.summaries()],
            [("20261115-015200", "Wrist pain", 2), ("20261115-010500", "Laceration", 0)],
        )
        self.assertEqual(self.store.summaries()[0]["handoff"], "Fracture suspected.")

    def test_a_missing_visit_raises(self):
        with self.assertRaises(KeyError):
            self.store.load("20261115-999999")

    def test_ids_that_are_not_timestamps_are_refused(self):
        for bad in ("../secrets", "20261115", "20261115-015200.json", "a/b", ""):
            with self.assertRaises(ValueError):
                self.store.save(bad, record())
            with self.assertRaises(ValueError):
                self.store.load(bad)

    def test_audio_is_kept_next_to_the_visit(self):
        self.assertIsNone(self.store.audio_path("20261115-015200"))
        self.store.save_audio("20261115-015200", b"RIFFdata")
        self.assertEqual(self.store.audio_path("20261115-015200").read_bytes(), b"RIFFdata")

    def test_delete_removes_the_visit_and_its_audio(self):
        self.store.save("20261115-015200", record())
        self.store.save_audio("20261115-015200", b"RIFFdata")
        self.store.delete("20261115-015200")
        self.assertEqual(self.store.summaries(), [])
        self.assertIsNone(self.store.audio_path("20261115-015200"))

    def test_export_puts_every_note_in_one_text_oldest_first(self):
        self.store.save("20261115-015200", record(text="SECOND NOTE"))
        self.store.save("20261115-010500", record(text="FIRST NOTE"))
        text = self.store.export_text()
        self.assertIn("2 visits", text)
        self.assertLess(text.index("FIRST NOTE"), text.index("SECOND NOTE"))

    def test_a_damaged_file_is_skipped_not_fatal(self):
        self.store.save("20261115-015200", record())
        (self.store.folder / "20261115-010500.json").write_text("{not json")
        self.assertEqual([v["id"] for v in self.store.summaries()], ["20261115-015200"])


if __name__ == "__main__":
    unittest.main()
