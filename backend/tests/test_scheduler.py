import csv
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient
import main
from main import app
from solver import load_instance_from_dir, parse_instance, solve_scenario, REQUIRED_HEADERS, OUTPUT_HEADERS
from solver.loader import CsvSchemaError, validate_instance
from solver.network import Calendar, Network, build_activity_plans
from solver.optimizer import _output
from solver.policies import STRICT_SUPPLY, STRICT_SCHEDULE, BALANCED
from solver.validation import validate_schedule
from solver.weather import WeatherOutlook, classify_condition, classify_sectors, make_day
import weather_service

DATA = Path(__file__).resolve().parents[1] / "data"
os.environ["SOLVER_TIME_LIMIT_SECONDS"] = "3"


def synthetic_outlook(data, severe_weeks):
    """A horizon outlook that is sunny except for `severe_weeks` -> number of stormy days that week."""
    start = data.parameters.horizon_start
    days = []
    for offset in range(data.parameters.horizon_weeks * 7):
        day = start + timedelta(days=offset)
        week, dow = offset // 7 + 1, offset % 7
        stormy = dow < severe_weeks.get(week, 0)
        days.append(make_day(day, 95 if stormy else 1, 40.0 if stormy else 0.0))
    return WeatherOutlook(days=days, source="synthetic", latitude=1.35, longitude=103.82)


def small(count=1, access_type="C", nature="Non-live (Others)"):
    data = load_instance_from_dir(str(DATA))
    c = data.contracts[0].model_copy(deep=True)
    c.nature_of_activity, c.access_type = nature, access_type
    c.planned_completion_date = data.parameters.horizon_start.replace(day=24)
    c.number_of_maximum_access_per_week, c.number_of_workfronts = 3, 2
    data.contracts = [c]
    a = data.activities[0].model_copy(deep=True)
    a.start_location_id = a.end_location_id = "SEC:ALP:S01_S02:EB"
    a.planned_start_date = data.parameters.horizon_start
    a.total_accesses, a.predecessor_activity_id = 1, None
    data.activities = [a.model_copy(update={"activity_id": f"T{i}"}) for i in range(count)]
    for row in data.supply:
        row.supply_capacity = 1
    return data


class SolverTests(unittest.TestCase):
    def test_all_reference_scenarios(self):
        data = load_instance_from_dir(str(DATA))
        for scenario in "ABC":
            with self.subTest(scenario=scenario):
                out = solve_scenario(scenario, data)
                self.assertTrue(out.feasible, out.hard_violations)
                self.assertEqual(len({r.activity_id for r in out.schedule_access}), 54)
                self.assertEqual(validate_schedule(data, out), [])
                if scenario == "A":
                    self.assertEqual(out.soft_scores.eclo_nights_total, 0)
                    self.assertEqual(out.soft_scores.excess_access_nights_total, 0)
                if scenario == "B":
                    self.assertEqual(out.soft_scores.overrun_days_total, 0)

    def test_extra_supply_does_not_bypass_pm_closures(self):
        data = small(3, "PM")
        data.contracts[0].planned_completion_date = Calendar(data.parameters.horizon_start, 30).sunday_of(1)
        a, b, c = [solve_scenario(s, data) for s in "ABC"]
        self.assertTrue(a.feasible)
        self.assertTrue(c.feasible)
        self.assertFalse(b.feasible)
        self.assertIn("planned_date", {v.rule for v in b.hard_violations})
        self.assertEqual(max(r.week for r in a.schedule_access), 3)
        for out in (a, b, c):
            self.assertEqual(len({r.week for r in out.schedule_access}), 3)
            self.assertNotIn("closure", {v.rule for v in out.hard_violations})

    def test_supply_tradeoff_with_weather_outage(self):
        data = small()
        net = Network.build(data)
        loc = next(loc for loc in net.supply if net.location_kind(loc) == "viaduct")
        data.activities[0].start_location_id = data.activities[0].end_location_id = loc
        data.contracts[0].planned_completion_date = Calendar(data.parameters.horizon_start, 30).sunday_of(1)
        data.weather = synthetic_outlook(data, {1: 7})
        a, b, c = [solve_scenario(s, data) for s in "ABC"]
        self.assertTrue(all(o.feasible for o in (a, b, c)))
        self.assertEqual(a.schedule_access[0].week, 2)
        for out in (b, c):
            self.assertEqual(out.schedule_access[0].week, 1)
            self.assertGreater(out.soft_scores.excess_access_nights_total, 0)

    def test_co_share_packs_four_coworkers(self):
        data = small(4)
        data.contracts[0].number_of_workfronts = 4  # rule 8 would otherwise split them over two nights
        out = solve_scenario("A", data)
        self.assertTrue(out.feasible)
        self.assertEqual({r.week for r in out.schedule_access}, {1})
        self.assertEqual(len({r.co_share_group for r in out.schedule_occupancy}), 1)

    def test_overlapping_coworkers_must_share_one_group(self):
        data = small(2)
        for row in data.supply:
            row.supply_capacity = 4
        out = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 2, 0)]})
        self.assertIn("closure", {v.rule for v in out.hard_violations})
        out = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 1, 0)]})
        self.assertTrue(out.feasible, out.hard_violations)

    def test_buffer_only_overlap_does_not_block_work(self):
        data = small(2, nature="Non-live (Consist)")
        data.activities[1].start_location_id = data.activities[1].end_location_id = "SEC:ALP:S04_H01:EB"
        for group in (1, 2):
            out = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, group, 0)]})
            self.assertTrue(out.feasible, out.hard_violations)

    def test_connected_coshare_chain_is_one_possession(self):
        data = small(3, nature="Live")
        data.contracts[0].number_of_workfronts = 3
        for activity, sector in zip(data.activities, ("S01_S02", "S02_S03", "S03_S04")):
            activity.start_location_id = activity.end_location_id = f"SEC:ALP:{sector}:EB"
        out = _output(data, STRICT_SUPPLY, {a.activity_id: [(1, 1, 0)] for a in data.activities})
        self.assertTrue(out.feasible, out.hard_violations)

    def test_predecessor_and_fractional_workload(self):
        data = small(2)
        data.activities[0].total_accesses = 2.5
        data.activities[1].predecessor_activity_id = "T0"
        out = solve_scenario("A", data)
        self.assertTrue(out.feasible)
        self.assertEqual(len([r for r in out.schedule_access if r.activity_id == "T0"]), 3)
        self.assertGreater(min(r.week for r in out.schedule_access if r.activity_id == "T1"),
                           max(r.week for r in out.schedule_access if r.activity_id == "T0"))

    def test_zero_supply_is_not_invented(self):
        data = small()
        data.supply[0].supply_capacity = 0
        out = solve_scenario("A", data)
        self.assertFalse(out.feasible)
        self.assertIn("workload", {v.rule for v in out.hard_violations})
        self.assertIsNone(out.soft_scores.objective_score)

    def test_long_workload_not_truncated(self):
        data = small()
        data.activities[0].total_accesses = 120
        data.parameters.horizon_weeks = 1
        out = solve_scenario("A", data)
        self.assertTrue(out.feasible)
        self.assertEqual(len(out.schedule_access), 120)

    def test_impossible_b_still_returns_complete_workload(self):
        data = small()
        data.activities[0].total_accesses = 8
        out = solve_scenario("B", data)
        self.assertFalse(out.feasible)
        self.assertIn("planned_date", {v.rule for v in out.hard_violations})
        self.assertGreaterEqual(sum(1.5 if r.eclo else 1 for r in out.schedule_access), 8)
        self.assertIsNone(out.soft_scores.objective_score)

    def test_platform_only_path(self):
        data = small()
        net = Network.build(data)
        self.assertEqual(net.expand_path("PLAT:ALP:S03:EB", "PLAT:ALP:S03:EB"), ["PLAT:ALP:S03:EB"])
        zone = net.buffer_footprint(["PLAT:ALP:S03:EB"], 1, False)
        self.assertIn("SEC:ALP:S02_S03:EB", zone)
        self.assertIn("SEC:ALP:S03_S04:EB", zone)
        self.assertNotIn("SEC:ALP:S01_S02:EB", zone)

    def test_live_crossover_and_affected_lines(self):
        data = small(nature="Live")
        a = data.activities[0]
        a.start_location_id = a.end_location_id = "SEC:ALP:H01_H02:EB"
        net = Network.build(data)
        p = build_activity_plans(data, net, Calendar(data.parameters.horizon_start, 30))[a.activity_id]
        self.assertEqual(p.lines_touched, {"ALP", "BET"})
        self.assertIn("SEC:BET:H01_H02:WB", p.buffer_zone)
        self.assertIn("PLAT:BET:H01:EB", p.buffer_zone)
        normal = net.buffer_footprint(p.path, 1, False)
        self.assertFalse(any(":BET:" in loc for loc in normal))

    def test_buffer_collision_needs_a_different_week(self):
        data = small(2, nature="Live")
        data.activities[1].start_location_id = data.activities[1].end_location_id = "SEC:ALP:S03_S04:EB"
        same_night = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 1, 0)]})
        self.assertIn("closure", {v.rule for v in same_night.hard_violations})
        # A different possession night in the same week does NOT clear it: the
        # closure holds for the week, and access_night is a per-contract index.
        other_night = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 2, 0)]})
        self.assertIn("closure", {v.rule for v in other_night.hard_violations})
        good = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(2, 1, 0)]})
        self.assertTrue(good.feasible, good.hard_violations)

    def test_buffer_ring_is_tunnel_sectors_only(self):
        """`up_to_buffer_sectors` counts tunnels; a non-Live ring closes no extra platform."""
        data = small(nature="Non-live (Consist)")
        net = Network.build(data)
        zone = net.buffer_footprint(["SEC:ALP:S03_S04:EB", "PLAT:ALP:S03:EB", "PLAT:ALP:S04:EB"], 1, False)
        self.assertIn("SEC:ALP:S02_S03:EB", zone)
        self.assertIn("SEC:ALP:S04_H01:EB", zone)
        self.assertNotIn("PLAT:ALP:S02:EB", zone)
        self.assertNotIn("PLAT:ALP:H01:EB", zone)

    def test_live_crossover_carries_its_buffer_onto_the_other_line(self):
        """Traction power dies across the interchange, taking the buffer span with it."""
        data = small(nature="Live")
        net = Network.build(data)
        zone = net.buffer_footprint(
            ["SEC:ALP:H01_H02:EB", "PLAT:ALP:H01:EB", "PLAT:ALP:H02:EB"], 2, True
        )
        self.assertIn("SEC:BET:S13_S14:WB", zone)
        self.assertIn("PLAT:BET:S13:WB", zone)
        self.assertIn("PLAT:BET:S16:EB", zone)
        self.assertNotIn("SEC:BET:S12_S13:WB", zone)
        self.assertNotIn("PLAT:BET:S17:EB", zone)

    def test_c_eclo_continuity_and_b_exemption(self):
        data = small()
        placements = {"T0": [(1, 1, 1), (3, 1, 1)]}
        c = _output(data, BALANCED, placements)
        b = _output(data, STRICT_SCHEDULE, placements)
        self.assertIn("eclo_window", {v.rule for v in c.hard_violations})
        self.assertTrue(b.feasible, b.hard_violations)

    def test_validator_detects_deleted_occupancy_and_workload(self):
        data = small()
        out = solve_scenario("A", data)
        out.schedule_occupancy.pop()
        self.assertIn("occupancy", {v.rule for v in validate_schedule(data, out)})
        out.schedule_access.clear()
        self.assertIn("workload", {v.rule for v in validate_schedule(data, out)})


class WeatherTests(unittest.TestCase):
    def test_sector_split_is_deterministic_60_40_and_platforms_are_sheltered(self):
        data = load_instance_from_dir(str(DATA))
        ids = [f"SEC:{x.line_code}:{x.from_station_id}_{x.to_station_id}" for x in data.sectors]
        kinds = classify_sectors(ids, 42)
        self.assertEqual(kinds, classify_sectors(reversed(ids), 42))
        self.assertEqual(sum(k == "tunnel" for k in kinds.values()), round(0.6 * len(ids)))
        self.assertNotEqual(kinds, classify_sectors(ids, 7))
        net = Network.build(data)
        self.assertEqual(net.location_kind("PLAT:ALP:S01:EB"), "platform")
        self.assertIn(net.location_kind("SEC:ALP:S01_S02:WB"), ("tunnel", "viaduct"))
        self.assertEqual(net.location_kind("SEC:ALP:S01_S02:WB"), net.location_kind("SEC:ALP:S01_S02:EB"))
        self.assertEqual(classify_condition(95, 0.0), ("thunderstorm", True))
        self.assertEqual(classify_condition(63, 27.4), ("heavy_rain", True))
        self.assertEqual(classify_condition(61, 3.0), ("rain", False))
        self.assertEqual(classify_condition(1, 0.0), ("sun", False))

    def test_severe_days_zero_viaduct_nights_but_not_tunnels_or_platforms(self):
        data = load_instance_from_dir(str(DATA))
        data.weather = synthetic_outlook(data, {2: 3, 5: 7})
        net = Network.build(data)
        viaducts = [loc for loc in net.supply if net.location_kind(loc) == "viaduct"]
        tunnels = [loc for loc in net.supply if net.location_kind(loc) == "tunnel"]
        self.assertTrue(viaducts and tunnels)
        for loc in viaducts:
            self.assertEqual(net.capacity(loc, 2), max(0, net.capacity(loc) - 3))
            self.assertEqual(net.capacity(loc, 5), 0)
            self.assertEqual(net.capacity(loc, 1), net.capacity(loc))
        for loc in tunnels + ["PLAT:ALP:S01:EB", "PLAT:BET:H01:WB"]:
            self.assertEqual(net.capacity(loc, 5), net.capacity(loc))
        # the standard solver honours the reduced supply and the validator agrees
        out = solve_scenario("A", data)
        self.assertTrue(out.feasible, out.hard_violations)
        used = {}
        for row in out.schedule_occupancy:
            used.setdefault((row.location_id, row.week), set()).add(row.co_share_group)
        for loc in viaducts:
            self.assertEqual(len(used.get((loc, 5), set())), 0)
        self.assertEqual(validate_schedule(data, out), [])


class InputAndApiTests(unittest.TestCase):
    def setUp(self):
        self.files = {name: (DATA / name).read_text() for name in REQUIRED_HEADERS}
        self.client = TestClient(app)
        main._ACTIVE_RUN = None  # activation is process-wide state; start each test clean
        # keep tests off the network and off the real state directory
        self.tmp = tempfile.TemporaryDirectory()
        main.STATE_DIR = Path(self.tmp.name)
        main.ACTIVE_FILE = main.STATE_DIR / "active_schedule.json"
        self._fetch = main.fetch_outlook
        self.outlook = synthetic_outlook(load_instance_from_dir(str(DATA)), {2: 3, 5: 7})
        main.fetch_outlook = lambda lat, lon, start, end, cache_dir=None, today=None: self.outlook

    def tearDown(self):
        main.fetch_outlook = self._fetch
        self.tmp.cleanup()

    def test_obsolete_saved_schedule_requires_a_new_preview(self):
        main.ACTIVE_FILE.write_text("[]")
        main._restore_active()
        self.assertIsNone(main._ACTIVE_RUN)
        saved = {"run_id": "old-closure-rules", "scenario": "A", "csv": {}, "view": {"feasible": True}}
        main.ACTIVE_FILE.write_text(json.dumps(saved))
        main._restore_active()
        self.assertIsNone(main._ACTIVE_RUN)
        self.assertTrue(main.ACTIVE_FILE.exists())
        main._RUNS[saved["run_id"]] = saved
        try:
            response = self.client.post("/api/schedule/activate", json={"run_id": saved["run_id"]})
            self.assertEqual(response.status_code, 409)
            self.assertIsNone(main._ACTIVE_RUN)
        finally:
            main._RUNS.pop(saved["run_id"], None)

    def test_infeasible_preview_cannot_be_activated(self):
        main._RUNS["infeasible-preview"] = {
            "scenario": "B", "csv": {}, "view": {"feasible": False},
            "validation_version": main.VALIDATION_VERSION,
        }
        try:
            response = self.client.post("/api/schedule/activate", json={"run_id": "infeasible-preview"})
            self.assertEqual(response.status_code, 409)
            self.assertIsNone(main._ACTIVE_RUN)
        finally:
            main._RUNS.pop("infeasible-preview", None)

    def test_invalid_numbers_duplicates_and_cycles(self):
        bad = self.files.copy()
        bad["08_ACTIVITY_DETAILS.csv"] = bad["08_ACTIVITY_DETAILS.csv"].replace(",2,2027-05-24,", ",NaN,2027-05-24,", 1)
        with self.assertRaises(CsvSchemaError):
            parse_instance(bad)
        data = small(2)
        data.activities[0].predecessor_activity_id = "T1"
        data.activities[1].predecessor_activity_id = "T0"
        with self.assertRaisesRegex(CsvSchemaError, "cycle"):
            validate_instance(data)
        data = small(2)
        data.activities[1].activity_id = "T0"
        with self.assertRaisesRegex(CsvSchemaError, "Duplicate"):
            validate_instance(data)

    def test_upload_all_scenarios_and_snapshot_downloads(self):
        # A changed CSV identifier proves the uploaded instance, rather than the bundled data, is solved.
        self.files["08_ACTIVITY_DETAILS.csv"] = self.files["08_ACTIVITY_DETAILS.csv"].replace("A001", "UPLOADED_ACTIVITY")
        self.files["01_LINES.csv"] = self.files["01_LINES.csv"].replace("Line Alpha", "Uploaded Alpha")
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        for scenario in "ABC":
            response = self.client.post("/api/reschedule", data={"scenario": scenario}, files=uploads)
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["feasible"], body["hard_violations"])
            self.assertIn("UPLOADED_ACTIVITY", {t["activity_id"] for t in body["tasks"]})
            self.assertIn("Uploaded Alpha", {line["line_name"] for line in body["network"]["lines"]})
            stations = body["network"]["stations"]
            self.assertTrue(any(station["station_id"] == "H01" and station["is_interchange"] == 1 for station in stations))
            self.assertTrue(all("seq" in station and "line_code" in station for station in stations))
            old_id = body["run_id"]
            self.client.get(f"/api/schedule?scenario={scenario}")
            for filename, headers in OUTPUT_HEADERS.items():
                download = self.client.get(f"/api/download/{scenario}/{filename}?run_id={old_id}")
                self.assertEqual(download.status_code, 200)
                reader = csv.DictReader(io.StringIO(download.text))
                self.assertEqual(reader.fieldnames, headers)
                rows = list(reader)
                if filename == "SCHEDULE_ACCESS.csv":
                    self.assertIn("UPLOADED_ACTIVITY", {r["activity_id"] for r in rows})

    def test_preview_then_activate_becomes_the_active_schedule(self):
        self.assertEqual(self.client.get("/api/schedule/active").status_code, 204)
        self.assertEqual(self.client.post("/api/schedule/activate", json={"run_id": "nope"}).status_code, 404)
        self.files["08_ACTIVITY_DETAILS.csv"] = self.files["08_ACTIVITY_DETAILS.csv"].replace("A001", "PREVIEWED")
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        preview = self.client.post("/api/reschedule", data={"scenario": "B"}, files=uploads).json()
        evaluation = preview["evaluation"]
        self.assertEqual(evaluation["access_nights_total"], len(preview["tasks"]))
        self.assertEqual(evaluation["objective_score"], preview["soft_scores"]["objective_score"])
        self.assertEqual(evaluation["feasible"], preview["feasible"])
        # a later solve does not change what is active until it is explicitly implemented
        activated = self.client.post("/api/schedule/activate", json={"run_id": preview["run_id"]})
        self.assertEqual(activated.status_code, 200, activated.text)
        self.client.get("/api/schedule?scenario=A")
        active = self.client.get("/api/schedule/active").json()
        self.assertEqual(active["run_id"], preview["run_id"])
        self.assertEqual(active["scenario"], "B")
        self.assertTrue(active["active"])
        self.assertIn("PREVIEWED", {t["activity_id"] for t in active["tasks"]})

    def test_weather_aware_preview_activation_persists_to_disk(self):
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        body = self.client.post("/api/reschedule", data={"scenario": "A", "weather_enabled": "true"}, files=uploads).json()
        self.assertTrue(body["weather_enabled"])
        self.assertTrue(body["weather_aware"])  # legacy alias still served
        self.assertEqual(body["weather_severe_weeks"], [2, 5])
        self.assertEqual(len(body["weather"]["days"]), 30 * 7)
        self.assertEqual(sum(1 for d in body["weather"]["days"] if d["severe"]), 10)
        kinds = {s["sector_id"]: s["sector_kind"] for s in body["network"]["sectors"]}
        self.assertEqual(sorted(set(kinds.values())), ["tunnel", "viaduct"])
        self.assertGreater(body["weather_outages"], 0)
        # weather off: same instance, outlook still shipped for the timeline, supply untouched
        plain = self.client.post("/api/reschedule", data={"scenario": "A", "weather_enabled": "false"}, files=uploads).json()
        self.assertFalse(plain["weather_enabled"])
        self.assertEqual(set(body["soft_scores"]), set(plain["soft_scores"]))  # no custom score metrics
        # a stormy season must move the standard objective (through overrun / excess / ECLO, nothing else)
        self.outlook = synthetic_outlook(load_instance_from_dir(str(DATA)), {w: 7 for w in range(1, 16)})
        stormy = self.client.post("/api/reschedule", data={"scenario": "A", "weather_enabled": "true"}, files=uploads).json()
        self.assertEqual(stormy["weather_severe_weeks"], list(range(1, 16)))
        self.assertNotEqual(stormy["soft_scores"]["objective_score"], plain["soft_scores"]["objective_score"])
        self.assertGreater(stormy["soft_scores"]["overrun_days_total"], plain["soft_scores"]["overrun_days_total"])
        self.assertEqual(plain["weather_outages"], 0)
        self.assertEqual(len(plain["weather"]["days"]), 30 * 7)
        # implement, then simulate a restart: the active run comes back from disk
        self.assertEqual(self.client.post("/api/schedule/activate", json={"run_id": body["run_id"]}).status_code, 200)
        self.assertTrue(main.ACTIVE_FILE.exists())
        main._RUNS.clear()
        main._ACTIVE_RUN = None
        self.assertEqual(self.client.get("/api/schedule/active").status_code, 204)
        main._restore_active()
        restored = self.client.get("/api/schedule/active").json()
        self.assertEqual(restored["run_id"], body["run_id"])
        self.assertTrue(restored["weather_enabled"])
        for filename in OUTPUT_HEADERS:
            self.assertEqual(self.client.get(f"/api/download/A/{filename}?run_id={body['run_id']}").status_code, 200)

    def test_weather_unavailable_only_blocks_weather_aware_solves(self):
        def unavailable(*args, **kwargs):
            raise weather_service.WeatherUnavailable("offline")
        main.fetch_outlook = unavailable
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        self.assertEqual(self.client.post("/api/reschedule", data={"scenario": "A", "weather_enabled": "true"}, files=uploads).status_code, 503)
        body = self.client.post("/api/reschedule", data={"scenario": "A"}, files=uploads).json()
        self.assertIsNone(body["weather"])
        self.assertIn("offline", body["weather_error"])

    def test_missing_duplicate_uploads_and_bad_scenario(self):
        self.assertEqual(self.client.get("/api/schedule?scenario=Z").status_code, 400)
        self.assertEqual(self.client.post("/api/reschedule", data={"scenario": "A"}).status_code, 422)
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        self.assertEqual(self.client.post("/api/reschedule", data={"scenario": "A"}, files=uploads + uploads[:1]).status_code, 422)


if __name__ == "__main__":
    unittest.main()
