"""Tests for calendar_overlay.py. Run: python -m unittest test_calendar_overlay -v  (from this folder)."""
import json
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import calendar_overlay as co

SAMPLE = (Path(__file__).parent / "sample_response.json").read_text(encoding="utf-8")
IDS = {"Raza": "1", "Ivan": "2", "Ammana": "3", "Jawad": "4", "Osaid": "5", "Ayeshah": "6"}
# the Intercom teammates, as phase1_cmd.list_admins(client) returns them (the emails match the sample's)
ADMINS = [{"id": 1, "email": "ahmed.raza@autoleap.com"}, {"id": 2, "email": "ivan@autoleap.com"}, {"id": 3, "email": "ammana@autoleap.com"},
          {"id": 4, "email": "muhammad.jawad@autoleap.com"}, {"id": 5, "email": "osaid@autoleap.com"}, {"id": 6, "email": "ayeshah@autoleap.com"}]
D = date(2026, 11, 16)  # a Monday


def plan():
    return co.parse_plan(SAMPLE, D, 15)


def entry(offset):
    return co.day_entry(plan(), D + timedelta(days=offset))


class Resp:
    def __init__(self, text): self.text = text
    def read(self): return self.text.encode()
    def __enter__(self): return self
    def __exit__(self, *a): return False


class ShiftDay(unittest.TestCase):
    def at(self, h, m=0, d=16):
        return datetime(2026, 11, d, h, m, tzinfo=co.PKT)

    def test_boundary_is_3pm_pkt(self):
        self.assertEqual(co.shift_day(self.at(14, 59)), date(2026, 11, 15))
        self.assertEqual(co.shift_day(self.at(15, 0)), date(2026, 11, 16))
        self.assertEqual(co.shift_day(self.at(2, 0, 17)), date(2026, 11, 16))  # after midnight it is still Monday's shift

    def test_works_from_utc_times(self):
        self.assertEqual(co.shift_day(datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc)), date(2026, 11, 16))  # 15:00 PKT
        self.assertEqual(co.shift_day(datetime(2026, 11, 16, 9, 59, tzinfo=timezone.utc)), date(2026, 11, 15))

    def test_kinds(self):
        self.assertEqual([co.day_kind(D + timedelta(days=i)) for i in range(7)], ["weekday"] * 5 + ["saturday", "sunday"])

    def test_rotation_day_for_a_weekend_is_friday(self):
        self.assertEqual(co.rotation_day(date(2026, 11, 21)), date(2026, 11, 20))  # Saturday
        self.assertEqual(co.rotation_day(date(2026, 11, 22)), date(2026, 11, 20))  # Sunday
        self.assertEqual(co.rotation_day(date(2026, 11, 18)), date(2026, 11, 18))  # a weekday is itself


class Parse(unittest.TestCase):
    def test_sample_parses(self):
        p = plan()
        self.assertEqual(p["version"], 1)
        self.assertEqual(len(p["days"]), 15)

    def test_rejects_bad_answers(self):
        for bad in ("not json", "[]", '{"version": 2}', '{"version": 1, "days": []}'):
            with self.assertRaises(co.CalendarError):
                co.parse_plan(bad, D, 1)

    def test_rejects_missing_day_and_wrong_kind(self):
        p = json.loads(SAMPLE)
        with self.assertRaises(co.CalendarError):
            co.parse_plan(SAMPLE, D, 16)  # asked for a day the answer does not have
        p["days"][5]["kind"] = "weekday"  # Saturday reported as a weekday
        with self.assertRaises(co.CalendarError):
            co.parse_plan(json.dumps(p), D, 15)

    def test_rejects_malformed_decision(self):
        p = json.loads(SAMPLE)
        p["days"][1]["decisions"][0]["queue"] = "everywhere"
        with self.assertRaises(co.CalendarError):
            co.parse_plan(json.dumps(p), D, 15)


class Overlay(unittest.TestCase):
    def test_edited_day(self):
        o, problems, names = co.overlay_for(entry(1), IDS)
        self.assertEqual(o, {"2": "phase1"})  # Ivan moved to Phase 1; Jawad (the rotation person) is normal
        self.assertEqual((problems, names), ([], {"2": "Ivan"}))

    def test_queue_cover(self):
        self.assertEqual(co.overlay_for(entry(2), IDS)[0], {"3": "phase1"})

    def test_quiet_day_has_no_overlay(self):
        self.assertEqual(co.overlay_for(entry(0), IDS), ({}, [], {}))

    def test_saturday_names_the_rotation_person_as_vip_so_they_move_to_vip(self):
        e = entry(5)  # Sat 21 Nov: weekend cover Phase 1 Ivan, VIP Jawad + Osaid; Jawad is the rotation person
        o, _, _ = co.overlay_for(e, IDS, apply_to_leads=True)
        self.assertEqual(o, {"2": "phase1", "4": "vip", "5": "vip"})
        self.assertEqual(e["rotationPhase1"], "Jawad")

    def test_saturday_rotation_person_not_named_stays_where_they_are(self):
        e = entry(12)  # Sat 28 Nov: weekend cover names Raza + Osaid as VIP; Jawad (rotation) is not named
        o, _, _ = co.overlay_for(e, IDS, apply_to_leads=True)
        self.assertNotIn("4", o)  # no decision for Jawad: he stays on Phase 1
        self.assertEqual(o, {"6": "phase1", "1": "vip", "5": "vip"})

    def test_sunday_holds(self):
        self.assertEqual(co.overlay_for(entry(6), IDS), ({}, [], {}))
        self.assertEqual(entry(6)["kind"], "sunday")

    def test_unknown_name_is_skipped_and_reported(self):
        o, problems, _ = co.overlay_for(entry(1), {"Raza": "1"})
        self.assertEqual(o, {})
        self.assertEqual(len(problems), 1)
        self.assertIn("Ivan", problems[0])

    def test_names_match_without_case(self):
        self.assertEqual(co.overlay_for(entry(1), {"ivan": "2"})[0], {"2": "phase1"})

    def test_leads_are_left_alone_unless_allowed(self):
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": "Osaid", "queue": "phase1", "reason": "x", "lead": True}]}
        self.assertEqual(co.overlay_for(e, IDS)[0], {})
        self.assertEqual(co.overlay_for(e, IDS, apply_to_leads=True)[0], {"5": "phase1"})

    def test_too_many_changes_are_refused(self):
        names = {f"P{i}": str(i) for i in range(12)}
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": n, "queue": "vip", "reason": "x", "lead": False} for n in names]}
        with self.assertRaises(co.CalendarError):
            co.overlay_for(e, names)


class EmailCheck(unittest.TestCase):
    """The fallback check: the Intercom ID must belong to the teammate whose email the calendar sent."""

    def test_matching_email_passes(self):
        o, problems, _ = co.overlay_for(entry(1), IDS, admins=ADMINS)
        self.assertEqual((o, problems), ({"2": "phase1"}, []))

    def test_wrong_id_in_the_map_is_refused(self):
        wrong = dict(IDS, Ivan="3")  # Ivan's ID points at Ammana
        o, problems, _ = co.overlay_for(entry(1), wrong, admins=ADMINS)
        self.assertEqual(o, {})
        self.assertIn("ammana@autoleap.com", problems[0])  # says who the ID really is

    def test_an_id_that_is_not_a_teammate_is_refused(self):
        o, problems, _ = co.overlay_for(entry(1), dict(IDS, Ivan="999"), admins=ADMINS)
        self.assertEqual(o, {})
        self.assertIn("not a teammate", problems[0])

    def test_email_comparison_ignores_case(self):
        admins = [dict(a, email=a["email"].upper()) for a in ADMINS]
        self.assertEqual(co.overlay_for(entry(1), IDS, admins=admins)[0], {"2": "phase1"})

    def test_name_missing_from_the_map_is_found_by_email(self):
        o, problems, names = co.overlay_for(entry(1), {"Raza": "1"}, admins=ADMINS)
        self.assertEqual((o, problems, names), ({"2": "phase1"}, [], {"2": "Ivan"}))

    def test_two_teammates_with_one_email_is_not_guessed(self):
        admins = ADMINS + [{"id": 77, "email": "ivan@autoleap.com"}]
        o, problems, _ = co.overlay_for(entry(1), {"Raza": "1"}, admins=admins)
        self.assertEqual(o, {})
        self.assertEqual(len(problems), 1)

    def test_calendar_without_an_email_cannot_be_verified(self):
        e = json.loads(json.dumps(entry(1)))
        e["decisions"][0]["email"] = None
        o, problems, _ = co.overlay_for(e, IDS, admins=ADMINS)
        self.assertEqual(o, {})
        self.assertIn("cannot be checked", problems[0])
        # a team that accepts the name map alone can allow it
        self.assertEqual(co.overlay_for(e, IDS, admins=ADMINS, require_email=False)[0], {"2": "phase1"})

    def test_one_bad_person_does_not_stop_the_others(self):
        e = entry(5)
        wrong = dict(IDS, Jawad="3")  # Jawad's ID is wrong, Ivan and Osaid are fine
        o, problems, _ = co.overlay_for(e, wrong, apply_to_leads=True, admins=ADMINS)
        self.assertEqual(o, {"2": "phase1", "5": "vip"})
        self.assertEqual(len(problems), 1)

    def test_without_admins_the_check_is_skipped(self):
        self.assertEqual(co.overlay_for(entry(1), IDS)[0], {"2": "phase1"})


class Teams(unittest.TestCase):
    def test_phase1_moves_out_of_vip(self):
        self.assertEqual(co.apply_overlay(["9"], ["2", "3"], {"2": "phase1"}), (["9", "2"], ["3"]))

    def test_vip_moves_out_of_phase1(self):
        self.assertEqual(co.apply_overlay(["9", "6"], ["3"], {"6": "vip"}), (["9"], ["3", "6"]))

    def test_both_and_idempotent(self):
        once = co.apply_overlay(["9"], ["3"], {"3": "both"})
        self.assertEqual(once, (["9", "3"], ["3"]))
        self.assertEqual(co.apply_overlay(*once, {"3": "both"}), once)

    def test_empty_overlay_changes_nothing(self):
        self.assertEqual(co.apply_overlay(["9"], ["3"], {}), (["9"], ["3"]))

    def test_revert_goes_back_to_the_normal_queue(self):
        prev = co.state_marker(entry(1), {"2": "phase1", "6": "vip"}, {"2": "Ivan", "6": "Ayeshah"})
        self.assertEqual(co.revert_targets(prev, {"2": "phase1"}, plan()), {"6": "phase1"})  # Ayeshah is Phase 1 normally
        self.assertEqual(co.revert_targets(None, {}, plan()), {})

    def test_revert_never_touches_the_rotation_people(self):
        prev = co.state_marker(entry(1), {"4": "vip", "6": "vip"}, {"4": "Jawad", "6": "Ayeshah"})
        self.assertEqual(co.revert_targets(prev, {}, plan(), exclude=["4"]), {"6": "phase1"})

    def test_state_marker_changes_on_a_new_day_or_edit(self):
        e1, e2 = entry(0), entry(1)
        self.assertNotEqual(co.state_marker(e1, {}), co.state_marker(e2, {}))
        self.assertNotEqual(co.state_marker(e2, {}), co.state_marker(e2, {"2": "phase1"}))
        self.assertEqual(co.state_marker(e2, {"b": "vip", "a": "phase1"}), co.state_marker(e2, {"a": "phase1", "b": "vip"}))


class Notes(unittest.TestCase):
    def test_rotation_check(self):
        self.assertIsNone(co.rotation_check(entry(0), "Jawad"))
        self.assertIn("Raza", co.rotation_check(entry(0), "Raza"))
        self.assertIsNone(co.rotation_check(entry(5), "Jawad"))  # Saturday: Friday's person
        self.assertIsNone(co.rotation_check(entry(6), "Raza"))  # Sunday: not compared

    def test_source_notes(self):
        p = json.loads(SAMPLE)
        self.assertEqual(len(co.source_notes(p)), 2)  # the sample came from the stored copy
        p["sources"] = {"weekendCover": "sheet", "rotation": "sheet"}
        self.assertEqual(co.source_notes(p), [])


class Fetch(unittest.TestCase):
    def test_success_and_headers(self):
        seen = {}

        def opener(req, timeout):
            seen["url"], seen["auth"], seen["timeout"] = req.full_url, req.get_header("Authorization"), timeout
            return Resp(SAMPLE)
        p = co.fetch_plan("https://cal.example/", "KEY", D, 15, opener=opener)
        self.assertEqual(p["version"], 1)
        self.assertEqual(seen["auth"], "Bearer KEY")
        self.assertEqual(seen["url"], "https://cal.example/api/v1/intercom-plan?from=2026-11-16&days=15")

    def test_wrong_key_is_not_retried(self):
        calls = []

        def opener(req, timeout):
            calls.append(1)
            raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)
        with self.assertRaises(co.CalendarError):
            co.fetch_plan("https://cal.example", "bad", D, opener=opener)
        self.assertEqual(len(calls), 1)

    def test_network_error_is_retried_once_then_raises(self):
        calls = []

        def opener(req, timeout):
            calls.append(1)
            raise urllib.error.URLError("down")
        co.time.sleep = lambda s: None
        with self.assertRaises(co.CalendarError):
            co.fetch_plan("https://cal.example", "k", D, opener=opener)
        self.assertEqual(len(calls), 2)

    def test_garbage_answer_raises_calendar_error(self):
        with self.assertRaises(co.CalendarError):
            co.fetch_plan("https://cal.example", "k", D, opener=lambda req, timeout: Resp("<html>oops</html>"))


if __name__ == "__main__":
    unittest.main()
