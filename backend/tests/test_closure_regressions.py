"""Regressions from the three rejected submissions and their supplied reports."""
import csv
import io
from pathlib import Path
import unittest
from zipfile import ZipFile

from solver import load_instance_from_dir, solve_scenario
from solver.baseline import solve_baseline
from solver.schemas import SoftScores, SolveOutput
from solver.validation import validate_schedule

DATA = Path(__file__).resolve().parents[1] / "data"
FIXTURES = Path(__file__).parent / "fixtures" / "closure_reports"


class ClosureRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_instance_from_dir(str(DATA))

    def test_rejected_exports_reproduce_every_supplied_message(self):
        for scenario, count in zip("ABC", (47, 84, 47)):
            with self.subTest(scenario=scenario), ZipFile(FIXTURES / f"scenario_{scenario}.zip") as archive:
                def rows(name):
                    return list(csv.DictReader(io.StringIO(archive.read(name + ".csv").decode())))
                output = SolveOutput(
                    scenario=scenario, soft_scores=SoftScores(scenario=scenario),
                    schedule_access=rows("SCHEDULE_ACCESS"),
                    schedule_occupancy=rows("SCHEDULE_OCCUPANCY"), results=rows("RESULTS"),
                )
                violations = validate_schedule(self.data, output)
                actual = [v.detail for v in violations if v.rule == "closure"]
                expected = [line.split("] ", 1)[1] for line in
                            (FIXTURES / f"scenario_{scenario}.txt").read_text().splitlines()]
                self.assertEqual(len(expected), count)
                self.assertCountEqual(actual, expected)
                self.assertEqual({v.rule for v in violations}, {"closure"})

    def test_new_exports_and_constructive_fallback_have_no_closure_errors(self):
        for scenario in "ABC":
            for solve in (solve_scenario, solve_baseline):
                with self.subTest(scenario=scenario, solver=solve.__name__):
                    output = solve(scenario, self.data)
                    # Reparse the exported schema, rather than trusting cached flags.
                    parsed = SolveOutput.model_validate(output.model_dump())
                    violations = validate_schedule(self.data, parsed)
                    self.assertFalse([v for v in violations if v.rule == "closure"])
                    self.assertEqual(len({r.activity_id for r in parsed.schedule_access}), 54)
                    if solve is solve_scenario:
                        self.assertTrue(output.feasible, violations)
                        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
