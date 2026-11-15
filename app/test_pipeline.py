import unittest

from pipeline import (
    CLINICIAN,
    OTHER,
    PATIENT,
    Medication,
    Segment,
    assign_roles,
    check_allergies,
    check_medications,
    extract_json,
    find_source,
    format_transcript,
    merge_turns,
    number_values,
)


def seg(speaker, text, start=0.0, end=1.0):
    return Segment(speaker=speaker, start=start, end=end, text=text)


class MergeTurnsTest(unittest.TestCase):
    def test_consecutive_segments_from_one_speaker_become_one_turn(self):
        turns = merge_turns([seg(0, "What happened", 0, 1), seg(0, "this morning?", 1, 2), seg(1, "I fell.", 2, 3)])
        self.assertEqual([(t.id, t.speaker, t.text) for t in turns], [(1, 0, "What happened this morning?"), (2, 1, "I fell.")])
        self.assertEqual((turns[0].start, turns[0].end), (0, 2))

    def test_unlabeled_segment_joins_the_previous_turn(self):
        turns = merge_turns([seg(1, "It hurts"), seg(-1, "a lot."), seg(0, "Where?")])
        self.assertEqual([t.text for t in turns], ["It hurts a lot.", "Where?"])

    def test_blank_segments_are_dropped(self):
        self.assertEqual(merge_turns([seg(0, "  "), seg(1, "Hello.")])[0].text, "Hello.")


class AssignRolesTest(unittest.TestCase):
    def test_the_speaker_asking_questions_is_the_clinician(self):
        turns = merge_turns([seg(1, "I slipped on the ice and landed on my hand."), seg(0, "Any numbness? Any tingling?"), seg(1, "A little.")])
        self.assertEqual(assign_roles(turns), {0: CLINICIAN, 1: PATIENT})

    def test_tie_goes_to_the_first_speaker(self):
        turns = merge_turns([seg(3, "Hello."), seg(5, "Hi.")])
        self.assertEqual(assign_roles(turns), {3: CLINICIAN, 5: PATIENT})

    def test_a_third_speaker_is_other(self):
        turns = merge_turns([seg(0, "What happened? Where does it hurt?"), seg(1, "I fell and my wrist really hurts a lot."), seg(2, "Yes.")])
        self.assertEqual(assign_roles(turns)[2], OTHER)

    def test_no_turns_gives_no_roles(self):
        self.assertEqual(assign_roles([]), {})


class FormatTranscriptTest(unittest.TestCase):
    def test_lines_are_numbered_and_labeled(self):
        turns = merge_turns([seg(0, "What happened?"), seg(1, "I fell.")])
        self.assertEqual(format_transcript(turns, {0: CLINICIAN, 1: PATIENT}), "[1] CLINICIAN: What happened?\n[2] PATIENT: I fell.")


class ExtractJsonTest(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(extract_json('{"plan": ["splint"]}'), {"plan": ["splint"]})

    def test_json_inside_a_code_fence_with_prose(self):
        self.assertEqual(extract_json('Here is the note:\n```json\n{"plan": []}\n```'), {"plan": []})

    def test_reply_without_json_is_an_error(self):
        with self.assertRaises(ValueError):
            extract_json("I cannot write this note.")


class NumberValuesTest(unittest.TestCase):
    def test_digits_and_words_give_the_same_value(self):
        self.assertEqual(number_values("400 mg"), {400})
        self.assertEqual(number_values("four hundred milligrams"), {400})
        self.assertEqual(number_values("four hundred and fifty"), {450})
        self.assertEqual(number_values("twenty-five milligrams"), {25})
        self.assertEqual(number_values("one thousand units"), {1000})

    def test_decimals(self):
        self.assertEqual(number_values("2.5 mg"), {2.5})
        self.assertEqual(number_values("two point five milligrams"), {2.5})

    def test_separate_numbers_stay_separate(self):
        self.assertEqual(number_values("ten milligrams, two times a day"), {10, 2})

    def test_no_numbers(self):
        self.assertEqual(number_values("for the pain"), set())


class CheckMedicationsTest(unittest.TestCase):
    def setUp(self):
        self.turns = merge_turns(
            [
                seg(0, "Do you take any medication?"),
                seg(1, "Lisinopril, ten milligrams every morning."),
                seg(0, "I'll give you ibuprofen 400 milligrams for the pain."),
            ]
        )

    def check(self, **med):
        return check_medications([Medication(**med)], self.turns)[0]

    def test_drug_and_dose_said_in_the_cited_line(self):
        result = self.check(name="Ibuprofen", dose="400 mg", line=3)
        self.assertTrue(result.name_heard and result.dose_heard)
        self.assertEqual(result.line, 3)

    def test_dose_spoken_as_a_word_counts(self):
        self.assertTrue(self.check(name="lisinopril", dose="10 mg", line=2).dose_heard)

    def test_dose_written_as_words_matches_digits_in_the_transcript(self):
        self.assertTrue(self.check(name="ibuprofen", dose="four hundred milligrams", line=3).dose_heard)

    def test_dose_written_as_words_matches_words_in_the_transcript(self):
        self.assertTrue(self.check(name="lisinopril", dose="ten milligrams", line=2).dose_heard)

    def test_a_dose_that_was_never_said_is_not_heard(self):
        result = self.check(name="ibuprofen", dose="800 mg", line=3)
        self.assertTrue(result.name_heard)
        self.assertFalse(result.dose_heard)

    def test_a_drug_that_was_never_said_is_not_heard(self):
        result = self.check(name="morphine", dose="5 mg", line=3)
        self.assertFalse(result.name_heard)
        self.assertFalse(result.dose_heard)

    def test_wrong_line_is_corrected_to_where_the_drug_was_said(self):
        result = self.check(name="lisinopril", dose="10 mg", line=1)
        self.assertEqual(result.line, 2)
        self.assertTrue(result.name_heard)

    def test_misheard_drug_with_no_usable_line_still_finds_its_dose(self):
        # Whisper wrote "imbuprithin 500 mg", the model wrote "ibuprofen" and cited a line that isn't there.
        turns = merge_turns([seg(0, "I'm giving you imbuprithin 500 mg for the pain.")])
        result = check_medications([Medication(name="ibuprofen", dose="500 mg", line=7)], turns)[0]
        self.assertFalse(result.name_heard)
        self.assertTrue(result.dose_heard)
        self.assertEqual(result.line, 0)

    def test_unlocated_drug_with_a_dose_nobody_said_is_not_heard(self):
        result = self.check(name="morphine", dose="5 mg", line=9)
        self.assertFalse(result.name_heard)
        self.assertFalse(result.dose_heard)

    def test_no_dose_given_means_no_dose_heard(self):
        self.assertFalse(self.check(name="ibuprofen", dose="", line=3).dose_heard)


class FindSourceTest(unittest.TestCase):
    def setUp(self):
        self.turns = merge_turns(
            [
                seg(0, "Any numbness or tingling in your fingers?", 12.4, 14.3),
                seg(1, "A little tingling in my thumb.", 15.5, 17.1),
                seg(0, "Okay,", 29.0, 29.6),
                seg(0, "there's swelling and tenderness over the right wrist.", 29.8, 33.0),
                seg(0, "This looks like a distal radius fracture.", 36.9, 38.8),
                seg(0, "I'll give you... ibuprofen.", 45.8, 47.6),
                seg(0, "400 milligrams for the pain.", 48.1, 50.1),
            ]
        )

    def test_turns_keep_the_phrases_they_were_built_from(self):
        self.assertEqual(len(self.turns), 3)
        self.assertEqual([part.text for part in self.turns[2].parts][:2], ["Okay,", "there's swelling and tenderness over the right wrist."])
        self.assertEqual((self.turns[2].parts[1].start, self.turns[2].parts[1].end), (29.8, 33.0))

    def test_a_sentence_is_traced_to_the_phrase_that_said_it(self):
        source = find_source("swelling and tenderness over right wrist", self.turns)
        self.assertEqual(source.line, 3)
        self.assertEqual((source.start, source.end), (29.8, 33.0))
        self.assertEqual(source.quote, "there's swelling and tenderness over the right wrist.")

    def test_the_best_matching_line_wins(self):
        self.assertEqual(find_source("little tingling in thumb", self.turns).line, 2)

    def test_different_word_endings_still_match(self):
        self.assertEqual(find_source("tender and swollen wrist, looks like fractures", self.turns).line, 3)

    def test_a_sentence_spread_over_two_phrases_gets_both(self):
        source = find_source("give ibuprofen 400 milligrams for pain", self.turns)
        self.assertEqual((source.line, source.start, source.end), (3, 45.8, 50.1))
        self.assertEqual(source.quote, "I'll give you... ibuprofen. 400 milligrams for the pain.")

    def test_a_sentence_nobody_said_has_no_source(self):
        source = find_source("follow up in one week", self.turns)
        self.assertEqual((source.line, source.quote), (0, ""))

    def test_one_shared_word_is_not_a_source(self):
        self.assertEqual(find_source("severe chest pain radiating to the jaw", self.turns).line, 0)
        self.assertEqual(find_source("chest pain", self.turns).line, 0)

    def test_a_one_word_sentence_needs_that_word(self):
        self.assertEqual(find_source("fracture", self.turns).line, 3)
        self.assertEqual(find_source("sprain", self.turns).line, 0)

    def test_a_sentence_with_only_filler_words_has_no_source(self):
        self.assertEqual(find_source("the patient was not", self.turns).line, 0)

    def test_words_spread_across_a_long_turn_point_at_its_best_phrase(self):
        turns = merge_turns(
            [
                seg(0, "I landed on my left hand.", 1, 3),
                seg(0, "It hurts a lot.", 3, 5),
                seg(0, "Can you move it?", 5, 6),
                seg(0, "Not really.", 6, 7),
                seg(0, "It's just a pain.", 9, 10),
                seg(0, "Did you take any medications?", 11, 13),
                seg(0, "Yes, metformin.", 13, 15),
                seg(0, "Any allergies?", 15, 16),
                seg(0, "Okay, your wrist is swollen.", 20, 22),
            ]
        )
        source = find_source("pain in left wrist", turns)
        self.assertEqual(source.line, 1)
        self.assertIn(source.quote, [part.text for part in turns[0].parts])

    def test_turns_without_phrases_fall_back_to_the_whole_line(self):
        from pipeline import Turn

        turns = [Turn(id=1, speaker=0, start=2.0, end=6.0, text="My wrist hurts a lot.")]
        source = find_source("wrist hurts a lot", turns)
        self.assertEqual((source.line, source.start, source.end), (1, 2.0, 6.0))


class CheckAllergiesTest(unittest.TestCase):
    def setUp(self):
        self.turns = merge_turns(
            [
                seg(0, "Any allergies?"),
                seg(1, "I'm allergic to penicillin, it gives me a rash. Sulfa drugs too."),
            ]
        )

    def check(self, *names):
        return check_allergies(list(names), self.turns)

    def test_an_allergy_that_was_said_is_heard_with_its_line(self):
        result = self.check("Penicillin")[0]
        self.assertTrue(result.heard)
        self.assertEqual(result.line, 2)
        self.assertIn("penicillin", result.line_text)

    def test_filler_words_do_not_have_to_be_said(self):
        self.assertTrue(self.check("penicillin allergy")[0].heard)
        self.assertTrue(self.check("sulfa drugs")[0].heard)

    def test_an_allergy_nobody_said_is_not_heard(self):
        result = self.check("latex")[0]
        self.assertFalse(result.heard)
        self.assertEqual(result.line, 0)

    def test_a_reaction_nobody_said_makes_the_entry_not_heard(self):
        self.assertFalse(self.check("penicillin (anaphylaxis)")[0].heard)

    def test_no_known_allergies_points_at_where_allergies_were_discussed(self):
        turns = merge_turns([seg(0, "Any allergies?"), seg(1, "No, none that I know of.")])
        result = check_allergies(["No known allergies"], turns)[0]
        self.assertTrue(result.heard)
        self.assertEqual(result.line, 1)

    def test_no_known_allergies_is_not_heard_when_allergies_never_came_up(self):
        turns = merge_turns([seg(0, "What happened?"), seg(1, "I fell.")])
        self.assertFalse(check_allergies(["No known allergies"], turns)[0].heard)

    def test_each_allergy_is_checked_in_order(self):
        self.assertEqual([a.heard for a in self.check("penicillin", "latex", "sulfa")], [True, False, True])


if __name__ == "__main__":
    unittest.main()
