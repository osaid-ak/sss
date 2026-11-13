"""Tests for calendar_overlay.py. Run: python -m unittest test_calendar_overlay -v  (from this folder)."""
import json
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import calendar_overlay as co

SAMPLE = (Path(__file__).parent / "sample_response.json").read_text(encoding="utf-8")
IDS = {"Raza": "1", "Ivan": "2", "Ammana": "3", "Jawad": "4", "Osaid": "5", "Ayeshah": "6"}
D = date(2026, 11, 16)


def plan():
    return co.parse_plan(SAMPLE, D, 8)


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
        self.assertEqual([co.day_kind(D + timedelta(days=i)) for i in range(7)],
                         ["weekday"] * 5 + ["saturday", "sunday"])


class Parse(unittest.TestCase):
    def test_sample_parses(self):
        p = plan()
        self.assertEqual(p["version"], 1)
        self.assertEqual(len(p["days"]), 8)

    def test_rejects_bad_answers(self):
        for bad in ("not json", "[]", '{"version": 2}', '{"version": 1, "days": []}'):
            with self.assertRaises(co.CalendarError):
                co.parse_plan(bad, D, 1)

    def test_rejects_missing_day_and_wrong_kind(self):
        p = json.loads(SAMPLE)
        with self.assertRaises(co.CalendarError):
            co.parse_plan(SAMPLE, D, 9)  # asked for a day the answer does not have
        p["days"][5]["kind"] = "weekday"  # Saturday reported as a weekday
        with self.assertRaises(co.CalendarError):
            co.parse_plan(json.dumps(p), D, 8)

    def test_rejects_malformed_decision(self):
        p = json.loads(SAMPLE)
        p["days"][1]["decisions"][0]["queue"] = "everywhere"
        with self.assertRaises(co.CalendarError):
            co.parse_plan(json.dumps(p), D, 8)


class Overlay(unittest.TestCase):
    def test_edited_day(self):
        o, problems = co.overlay_for(co.day_entry(plan(), D + timedelta(days=1)), IDS)
        self.assertEqual(o, {"2": "phase1"})  # Ivan moved to Phase 1; Jawad (the rotation person) is normal
        self.assertEqual(problems, [])

    def test_queue_cover(self):
        o, _ = co.overlay_for(co.day_entry(plan(), D + timedelta(days=2)), IDS)
        self.assertEqual(o, {"3": "phase1"})

    def test_quiet_day_has_no_overlay(self):
        self.assertEqual(co.overlay_for(co.day_entry(plan(), D), IDS), ({}, []))

    def test_saturday_weekend_cover(self):
        e = co.day_entry(plan(), D + timedelta(days=5))
        o, _ = co.overlay_for(e, IDS)
        self.assertEqual(o, {"2": "phase1"})
        self.assertIsNone(co.baseline_person(e, "Jawad"))  # no rotation on Saturday: Jawad goes back to VIP

    def test_sunday_holds(self):
        e = co.day_entry(plan(), D + timedelta(days=6))
        self.assertEqual(co.overlay_for(e, IDS), ({}, []))
        self.assertEqual(e["kind"], "sunday")

    def test_monday_after_returns_to_the_sheet_person(self):
        e = co.day_entry(plan(), D + timedelta(days=7))
        self.assertEqual(co.baseline_person(e, "Jawad"), "Jawad")

    def test_unknown_name_is_skipped_and_reported(self):
        o, problems = co.overlay_for(co.day_entry(plan(), D + timedelta(days=1)), {"Raza": "1"})
        self.assertEqual(o, {})
        self.assertEqual(len(problems), 1)
        self.assertIn("Ivan", problems[0])

    def test_names_match_without_case(self):
        o, _ = co.overlay_for(co.day_entry(plan(), D + timedelta(days=1)), {"ivan": "2"})
        self.assertEqual(o, {"2": "phase1"})

    def test_leads_are_left_alone_unless_allowed(self):
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": "Osaid", "queue": "phase1", "reason": "x", "lead": True}]}
        self.assertEqual(co.overlay_for(e, IDS)[0], {})
        self.assertEqual(co.overlay_for(e, IDS, apply_to_leads=True)[0], {"5": "phase1"})

    def test_too_many_changes_are_refused(self):
        names = {f"P{i}": str(i) for i in range(12)}
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": n, "queue": "vip", "reason": "x", "lead": False} for n in names]}
        with self.assertRaises(co.CalendarError):
            co.overlay_for(e, names)


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
        p = plan()
        back = co.revert_targets({"2": "phase1", "6": "vip"}, {"2": "phase1"}, p, IDS)
        self.assertEqual(back, {"6": "phase1"})  # Ayeshah was moved to VIP yesterday and is not moved today: back to Phase 1
        self.assertEqual(co.revert_targets({}, {}, p, IDS), {})

    def test_revert_never_touches_the_rotation_people(self):
        p = plan()
        # Jawad ("4") is the rotation person: the baseline decides where he goes, not the calendar's normalQueue
        self.assertEqual(co.revert_targets({"4": "vip", "6": "vip"}, {}, p, IDS, exclude=["4"]), {"6": "phase1"})

    def test_state_marker_changes_on_a_new_day_or_edit(self):
        e1, e2 = co.day_entry(plan(), D), co.day_entry(plan(), D + timedelta(days=1))
        self.assertNotEqual(co.state_marker(e1, {}), co.state_marker(e2, {}))
        self.assertNotEqual(co.state_marker(e2, {}), co.state_marker(e2, {"2": "phase1"}))
        self.assertEqual(co.state_marker(e2, {"b": "vip", "a": "phase1"}), co.state_marker(e2, {"a": "phase1", "b": "vip"}))


class Check(unittest.TestCase):
    def test_rotation_check(self):
        e = co.day_entry(plan(), D)
        self.assertIsNone(co.rotation_check(e, "Jawad"))
        self.assertIn("Raza", co.rotation_check(e, "Raza"))
        self.assertIsNone(co.rotation_check(co.day_entry(plan(), D + timedelta(days=5)), "Raza"))  # Saturday: not compared


class Fetch(unittest.TestCase):
    def test_success_and_headers(self):
        seen = {}
        def opener(req, timeout):
            seen["url"], seen["auth"], seen["timeout"] = req.full_url, req.get_header("Authorization"), timeout
            return Resp(SAMPLE)
        p = co.fetch_plan("https://cal.example/", "KEY", D, 8, opener=opener)
        self.assertEqual(p["version"], 1)
        self.assertEqual(seen["auth"], "Bearer KEY")
        self.assertEqual(seen["url"], "https://cal.example/api/v1/intercom-plan?from=2026-11-16&days=8")

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
        import calendar_overlay
        calendar_overlay.time.sleep = lambda s: None
        with self.assertRaises(co.CalendarError):
            co.fetch_plan("https://cal.example", "k", D, opener=opener)
        self.assertEqual(len(calls), 2)

    def test_garbage_answer_raises_calendar_error(self):
        with self.assertRaises(co.CalendarError):
            co.fetch_plan("https://cal.example", "k", D, opener=lambda req, timeout: Resp("<html>oops</html>"))


if __name__ == "__main__":
    unittest.main()
