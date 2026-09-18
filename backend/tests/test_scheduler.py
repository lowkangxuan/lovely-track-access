import csv
import io
import os
from pathlib import Path
import unittest

from fastapi.testclient import TestClient
from main import app
from solver import load_instance_from_dir, parse_instance, solve_scenario, REQUIRED_HEADERS, OUTPUT_HEADERS
from solver.loader import CsvSchemaError, validate_instance
from solver.network import Calendar, Network, build_activity_plans
from solver.optimizer import _output
from solver.policies import STRICT_SUPPLY, STRICT_SCHEDULE, BALANCED
from solver.validation import validate_schedule

DATA = Path(__file__).resolve().parents[1] / "data"
os.environ["SOLVER_TIME_LIMIT_SECONDS"] = "3"


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

    def test_supply_tradeoff(self):
        data = small(3, "PM")
        data.contracts[0].planned_completion_date = Calendar(data.parameters.horizon_start, 30).sunday_of(1)
        a, b, c = [solve_scenario(s, data) for s in "ABC"]
        self.assertTrue(all(o.feasible for o in (a, b, c)))
        self.assertEqual(max(r.week for r in a.schedule_access), 3)
        self.assertEqual(max(r.week for r in b.schedule_access), 1)
        self.assertGreater(b.soft_scores.excess_access_nights_total, 0)
        self.assertGreaterEqual(max(r.week for r in c.schedule_access), 2)

    def test_co_share_packs_four_coworkers(self):
        data = small(4)
        out = solve_scenario("A", data)
        self.assertTrue(out.feasible)
        self.assertEqual({r.week for r in out.schedule_access}, {1})
        self.assertEqual(len({r.co_share_group for r in out.schedule_occupancy}), 1)

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

    def test_buffer_buffer_collision_and_separate_nights(self):
        data = small(2, nature="Non-live (Consist)")
        data.activities[1].start_location_id = data.activities[1].end_location_id = "SEC:ALP:S04_H01:EB"
        bad = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 1, 0)]})
        self.assertIn("closure", {v.rule for v in bad.hard_violations})
        good = _output(data, STRICT_SUPPLY, {"T0": [(1, 1, 0)], "T1": [(1, 2, 0)]})
        self.assertTrue(good.feasible, good.hard_violations)

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


class InputAndApiTests(unittest.TestCase):
    def setUp(self):
        self.files = {name: (DATA / name).read_text() for name in REQUIRED_HEADERS}
        self.client = TestClient(app)

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
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        for scenario in "ABC":
            response = self.client.post("/api/reschedule", data={"scenario": scenario}, files=uploads)
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["feasible"], body["hard_violations"])
            self.assertIn("UPLOADED_ACTIVITY", {t["activity_id"] for t in body["tasks"]})
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

    def test_missing_duplicate_uploads_and_bad_scenario(self):
        self.assertEqual(self.client.get("/api/schedule?scenario=Z").status_code, 400)
        self.assertEqual(self.client.post("/api/reschedule", data={"scenario": "A"}).status_code, 422)
        uploads = [("files", (name, raw, "text/csv")) for name, raw in self.files.items()]
        self.assertEqual(self.client.post("/api/reschedule", data={"scenario": "A"}, files=uploads + uploads[:1]).status_code, 422)


if __name__ == "__main__":
    unittest.main()
