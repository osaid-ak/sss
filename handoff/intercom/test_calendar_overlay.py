"""Tests for calendar_overlay.py. Run: python -m unittest test_calendar_overlay -v  (from this folder)."""
import json
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import calendar_overlay as co

SAMPLE = (Path(__file__).parent / "sample_response.json").read_text(encoding="utf-8")
IDS = {"Raza": "1", "Ivan": "2", "Ammana": "3", "Jawad": "4", "Osaid": "5", "Ayeshah": "6"}
ROTATION_IDS = ["1", "2", "3", "4"]  # rotation.py's `people`: the ones the sheet moves between Phase 1 and VIP
# the Intercom teammates, as phase1_cmd.list_admins(client) returns them (the emails match the sample's)
ADMINS = [{"id": 1, "email": "ahmed.raza@autoleap.com"}, {"id": 2, "email": "ivan@autoleap.com"}, {"id": 3, "email": "ammana@autoleap.com"},
          {"id": 4, "email": "muhammad.jawad@autoleap.com"}, {"id": 5, "email": "osaid@autoleap.com"}, {"id": 6, "email": "ayeshah@autoleap.com"}]
D = date(2026, 11, 16)  # a Monday


def plan():
    return co.parse_plan(SAMPLE, D, 22)


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
        self.assertEqual(plan()["version"], 1)
        self.assertEqual(len(plan()["days"]), 22)

    def test_rejects_bad_answers(self):
        for bad in ("not json", "[]", '{"version": 2}', '{"version": 1, "days": []}'):
            with self.assertRaises(co.CalendarError):
                co.parse_plan(bad, D, 1)

    def test_rejects_missing_day_and_wrong_kind(self):
        with self.assertRaises(co.CalendarError):
            co.parse_plan(SAMPLE, D, 23)  # asked for a day the answer does not have
        p = json.loads(SAMPLE)
        p["days"][5]["kind"] = "weekday"  # Saturday reported as a weekday
        with self.assertRaises(co.CalendarError):
            co.parse_plan(json.dumps(p), D, 15)

    def test_rejects_malformed_decisions_and_queues(self):
        for edit in (lambda p: p["days"][1]["decisions"][0].update(queue="everywhere"),
                     lambda p: p["days"][1]["queues"].update(Ivan="everywhere")):
            p = json.loads(SAMPLE)
            edit(p)
            with self.assertRaises(co.CalendarError):
                co.parse_plan(json.dumps(p), D, 15)


class Moves(unittest.TestCase):
    """The calendar's changes, mapped to Intercom IDs and checked against emails."""

    def test_edited_day(self):
        o, problems, names = co.overlay_for(entry(1), IDS)
        self.assertEqual(o, {"2": "phase1"})  # Ivan moved to Phase 1; Jawad (the rotation person) is normal
        self.assertEqual((problems, names), ([], {"2": "Ivan"}))

    def test_queue_cover(self):
        self.assertEqual(co.overlay_for(entry(2), IDS)[0], {"3": "phase1"})

    def test_quiet_day_has_no_moves(self):
        self.assertEqual(co.overlay_for(entry(0), IDS), ({}, [], {}))

    def test_saturday_that_names_the_rotation_person_as_vip(self):
        o, _, _ = co.overlay_for(entry(5), IDS, apply_to_leads=True)  # Sat 21: Phase 1 Ivan, VIP Jawad + Osaid; Jawad is the rotation person
        self.assertEqual(o, {"2": "phase1", "4": "vip", "5": "vip"})

    def test_saturday_that_does_not_name_the_rotation_person(self):
        o, _, _ = co.overlay_for(entry(12), IDS, apply_to_leads=True)  # Sat 28: Raza + Osaid are the VIPs
        self.assertNotIn("4", o)
        self.assertEqual(o, {"6": "phase1", "1": "vip", "5": "vip"})

    def test_sunday_has_no_moves(self):
        self.assertEqual(co.overlay_for(entry(6), IDS), ({}, [], {}))

    def test_unknown_name_is_skipped_and_reported(self):
        o, problems, _ = co.overlay_for(entry(1), {"Raza": "1"})
        self.assertEqual(o, {})
        self.assertIn("Ivan", problems[0])

    def test_names_match_without_case(self):
        self.assertEqual(co.overlay_for(entry(1), {"ivan": "2"})[0], {"2": "phase1"})

    def test_leads_are_left_alone_unless_allowed(self):
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": "Osaid", "queue": "phase1", "reason": "x", "lead": True}]}
        self.assertEqual(co.overlay_for(e, IDS)[0], {})
        self.assertEqual(co.overlay_for(e, IDS, apply_to_leads=True)[0], {"5": "phase1"})

    # the fallback that makes sure the right person is moved: the Intercom ID must belong to the teammate with the calendar's email
    def test_matching_email_passes(self):
        self.assertEqual(co.overlay_for(entry(1), IDS, admins=ADMINS)[:2], ({"2": "phase1"}, []))

    def test_wrong_id_in_the_map_is_refused_and_says_who_it_really_is(self):
        o, problems, _ = co.overlay_for(entry(1), dict(IDS, Ivan="3"), admins=ADMINS)
        self.assertEqual(o, {})
        self.assertIn("ammana@autoleap.com", problems[0])

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
        o, problems, _ = co.overlay_for(entry(1), {"Raza": "1"}, admins=ADMINS + [{"id": 77, "email": "ivan@autoleap.com"}])
        self.assertEqual((o, len(problems)), ({}, 1))

    def test_calendar_without_an_email_cannot_be_verified(self):
        e = json.loads(json.dumps(entry(1)))
        e["decisions"][0]["email"] = None
        o, problems, _ = co.overlay_for(e, IDS, admins=ADMINS)
        self.assertEqual(o, {})
        self.assertIn("cannot be checked", problems[0])
        self.assertEqual(co.overlay_for(e, IDS, admins=ADMINS, require_email=False)[0], {"2": "phase1"})

    def test_one_bad_person_does_not_stop_the_others(self):
        o, problems, _ = co.overlay_for(entry(5), dict(IDS, Jawad="3"), apply_to_leads=True, admins=ADMINS)
        self.assertEqual((o, len(problems)), ({"2": "phase1", "5": "vip"}, 1))

    def test_too_many_changes_are_refused(self):
        names = {f"P{i}": str(i) for i in range(12)}
        e = {"date": "2026-11-17", "kind": "weekday", "decisions": [{"name": n, "queue": "vip", "reason": "x", "lead": False} for n in names]}
        with self.assertRaises(co.CalendarError):
            co.overlay_for(e, names)

    def test_reasons_for_the_slack_message(self):
        self.assertEqual(co.reasons(entry(1)), {"Ivan": "day edited by a lead"})


class Teams(unittest.TestCase):
    def test_phase1_moves_out_of_vip(self):
        self.assertEqual(co.apply_overlay(["9"], ["2", "3"], {"2": "phase1"}), (["9", "2"], ["3"]))

    def test_vip_moves_out_of_phase1(self):
        self.assertEqual(co.apply_overlay(["9", "6"], ["3"], {"6": "vip"}), (["9"], ["3", "6"]))

    def test_both_and_idempotent(self):
        once = co.apply_overlay(["9"], ["3"], {"3": "both"})
        self.assertEqual(once, (["9", "3"], ["3"]))
        self.assertEqual(co.apply_overlay(*once, {"3": "both"}), once)

    def test_no_moves_change_nothing(self):
        self.assertEqual(co.apply_overlay(["9"], ["3"], {}), (["9"], ["3"]))


class Desired(unittest.TestCase):
    def test_the_sheet_baseline(self):
        self.assertEqual(co.sheet_baseline(ROTATION_IDS, "4"), {"1": "vip", "2": "vip", "3": "vip", "4": "phase1"})
        self.assertEqual(set(co.sheet_baseline(ROTATION_IDS, None).values()), {"vip"})

    def test_the_calendar_wins_over_the_sheet(self):
        base = co.sheet_baseline(ROTATION_IDS, "4")
        d = co.desired_state(base, {"4": "vip", "2": "phase1"}, {}, plan())  # a lead moved the sheet's Phase 1 person out and Ivan in
        self.assertEqual(d, {"1": "vip", "2": "phase1", "3": "vip", "4": "vip"})

    def test_someone_the_calendar_moved_earlier_goes_back_to_their_normal_queue(self):
        base = co.sheet_baseline(ROTATION_IDS, "4")
        d = co.desired_state(base, {}, {"6": "Ayeshah"}, plan())  # Ayeshah is not a rotation person; the calendar moved her yesterday
        self.assertEqual(d["6"], "phase1")  # her normal queue

    def test_pending_targets_are_the_changes_unless_it_is_a_reset_or_the_first_run(self):
        desired, last = {"1": "vip", "2": "phase1"}, {"1": "vip", "2": "vip"}
        self.assertEqual(co.pending_targets(desired, last), {"2": "phase1"})
        self.assertEqual(co.pending_targets(desired, last, reset=True), desired)
        self.assertEqual(co.pending_targets(desired, None), desired)
        self.assertEqual(co.pending_targets(desired, desired), {})


class Hourly(unittest.TestCase):
    """Hourly runs against a fake Intercom: the sheet is the intended state, the calendar's changes win, the automation acts on changes."""

    # who the sheet puts on Phase 1, by day offset from Mon 16 Nov (the sample's blocks: Jawad until Fri 27 Nov, Ivan from Mon 30 Nov)
    def sheet_person(self, offset):
        return "4" if offset < 14 else "2"

    def setUp(self):
        self.state = None
        # Intercom before the first run: Jawad (the sheet's Phase 1 person) on Phase 1, Ayeshah always on Phase 1, the rest in VIP
        self.p1, self.vip = ["4", "6"], ["1", "2", "3"]

    def hour(self, offset, reset=False, **kw):
        e = entry(offset)
        base = co.sheet_baseline(ROTATION_IDS, self.sheet_person(offset if e["kind"] == "weekday" else offset - (1 if e["kind"] == "saturday" else 2)))
        r = co.run_plan(plan(), e, IDS, self.state, self.p1, self.vip, base, reset=reset, admins=ADMINS, **kw)
        if not r["hold"]:
            self.p1, self.vip, self.state = r["p1"], r["vip"], r["new_state"]
        return r

    def manual(self, who, team):  # what /phase does in Intercom
        if team == "vip":
            self.p1, self.vip = [i for i in self.p1 if i != who], self.vip + ([who] if who not in self.vip else [])
        else:
            self.vip, self.p1 = [i for i in self.vip if i != who], self.p1 + ([who] if who not in self.p1 else [])

    def test_first_run_brings_everything_in_line(self):
        self.p1, self.vip = ["6"], ["1", "2", "3", "4"]  # Jawad is in VIP but the sheet says Phase 1
        r = self.hour(0)
        self.assertEqual(r["changed"], ["4"])
        self.assertIn("4", self.p1)
        self.assertNotIn("4", self.vip)

    def test_quiet_hours_and_quiet_days_change_nothing(self):
        self.hour(0)
        for _ in range(5):
            self.assertEqual(self.hour(0)["changed"], [])
        self.assertEqual(self.hour(3)["changed"], [])

    def test_a_lead_edit_is_applied_at_the_next_hourly_run_and_undone_the_next_day(self):
        self.hour(0)
        r = self.hour(1)  # Tue 17: the lead moved Ivan to Phase 1
        self.assertEqual(r["changed"], ["2"])
        self.assertIn("2", self.p1)
        self.assertNotIn("2", self.vip)
        self.assertEqual(self.hour(1)["changed"], [])
        r = self.hour(2)  # Wed 18: Ammana is on Phase 1 for the night, Ivan is back to the sheet's VIP
        self.assertEqual(r["changed"], ["2", "3"])
        self.assertIn("3", self.p1)
        self.assertIn("2", self.vip)

    def test_the_calendar_beats_the_sheet_when_they_disagree(self):
        self.hour(0)
        e = json.loads(json.dumps(entry(1)))
        e["decisions"] = [{"name": "Jawad", "email": "muhammad.jawad@autoleap.com", "queue": "vip", "reason": "day edited by a lead", "lead": False}]
        base = co.sheet_baseline(ROTATION_IDS, "4")  # the sheet says Jawad is on Phase 1
        r = co.run_plan(plan(), e, IDS, self.state, self.p1, self.vip, base, admins=ADMINS)
        self.assertIn("4", r["vip"])
        self.assertNotIn("4", r["p1"])

    def test_a_manual_move_lasts_until_the_sheet_or_calendar_changes_for_that_person(self):
        self.hour(0)
        self.manual("6", "vip")  # someone used /phase to put Ayeshah in VIP
        for off in (1, 2, 3, 4):
            self.hour(off)
            self.assertIn("6", self.vip, f"manual change was undone on day {off}")

    def test_the_monday_check_resets_manual_moves_of_the_rotation_people(self):
        self.hour(0)
        self.manual("2", "p1")  # someone used /phase to put Ivan (VIP by the sheet) on Phase 1
        self.assertEqual(self.hour(3)["changed"], [])  # a quiet day leaves it
        self.assertIn("2", self.p1)
        r = self.hour(7, reset=True)  # the Monday check brings everybody in line with the sheet and the calendar
        self.assertIn("2", r["changed"])
        self.assertIn("2", self.vip)
        self.assertNotIn("2", self.p1)

    def test_someone_the_calendar_moved_goes_back_when_it_stops_moving_them(self):
        self.hour(0)
        e = json.loads(json.dumps(entry(1)))
        e["decisions"] = [{"name": "Ayeshah", "email": "ayeshah@autoleap.com", "queue": "vip", "reason": "day edited by a lead", "lead": False}]
        base = co.sheet_baseline(ROTATION_IDS, "4")
        r = co.run_plan(plan(), e, IDS, self.state, self.p1, self.vip, base, admins=ADMINS)  # Tue: Ayeshah (not a rotation person) to VIP
        self.assertIn("6", r["vip"])
        self.p1, self.vip, self.state = r["p1"], r["vip"], r["new_state"]
        r = self.hour(2)  # Wed: no decision for her any more
        self.assertIn("6", self.p1)
        self.assertNotIn("6", self.vip)

    def test_saturday_follows_the_weekend_cover_and_monday_puts_the_rotation_person_back(self):
        for off in range(5):
            self.hour(off)
        r = self.hour(5)  # Sat 21: Jawad (the sheet's person) is named as VIP, Ivan as Phase 1
        self.assertEqual(set(r["changed"]), {"4", "2"})
        self.assertIn("4", self.vip)
        self.assertIn("2", self.p1)
        before = (list(self.p1), list(self.vip), json.dumps(self.state, sort_keys=True))
        self.assertTrue(self.hour(6)["hold"])  # Sunday: closed
        self.assertEqual((self.p1, self.vip, json.dumps(self.state, sort_keys=True)), before)
        r = self.hour(7)  # Mon 23: back to the sheet
        self.assertEqual(set(r["changed"]), {"4", "2"})
        self.assertIn("4", self.p1)
        self.assertIn("2", self.vip)

    def test_a_saturday_that_does_not_name_the_rotation_person_leaves_them_on_phase_1(self):
        for off in range(7, 12):
            self.hour(off)
        r = self.hour(12)  # Sat 28: Jawad is not named
        self.assertIn("4", self.p1)
        self.assertNotIn("4", r["changed"])

    def test_the_next_block_changes_the_rotation_person_on_its_monday(self):
        for off in range(5):
            self.hour(off)
        r = self.hour(14)  # Mon 30 Nov: the sheet's next block names Ivan
        self.assertEqual(set(r["changed"]), {"2", "4"})
        self.assertIn("2", self.p1)
        self.assertIn("4", self.vip)

    def test_too_many_moves_at_once_are_refused(self):
        base = co.sheet_baseline(ROTATION_IDS, "4")
        with self.assertRaises(co.CalendarError):
            co.run_plan(plan(), entry(0), IDS, None, ["1", "2", "3"], ["4"], base, admins=ADMINS, max_changes=1)  # 4 people would swap teams

    def test_cross_check_reports_a_disagreement_between_sheet_and_calendar(self):
        ids = {"1": "Raza", "2": "Ivan", "3": "Ammana", "4": "Jawad"}
        self.assertEqual(co.cross_check(entry(0), co.sheet_baseline(ROTATION_IDS, "4"), ids), [])
        out = co.cross_check(entry(0), co.sheet_baseline(ROTATION_IDS, "1"), ids)  # the sheet says Raza, the calendar says Jawad
        self.assertEqual(len(out), 2)
        self.assertEqual(co.cross_check(entry(6), {"4": "phase1"}, ids), [])  # Sunday: nothing to compare


class Notes(unittest.TestCase):
    def test_rotation_check(self):
        self.assertIsNone(co.rotation_check(entry(0), "Jawad"))
        self.assertIn("Raza", co.rotation_check(entry(0), "Raza"))
        self.assertIsNone(co.rotation_check(entry(6), "Raza"))

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
