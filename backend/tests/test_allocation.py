"""
Distance tracking & manpower allocation — unit tests.

Deliberately free of FastAPI and OR-Tools: this module is pure geometry and
matching, so the suite runs with the stdlib alone.

    python -m unittest tests.test_allocation -v
"""

import unittest
from pathlib import Path

from solver import load_instance_from_dir, parse_instance, REQUIRED_HEADERS
from solver.allocation import (
    allocate_teams,
    centroid,
    distance_km,
    location_point,
    required_specialty,
    resolve_fleet,
    station_coordinates,
    tier_number,
)
from solver.baseline import solve_baseline
from solver.loader import CsvSchemaError
from solver.network import Calendar, Network, build_activity_plans
from solver.schemas import Activity

DATA = Path(__file__).resolve().parent.parent / "data"

FLEET_HEADER = "team_id,base_station_id,coord_x,coord_y,activity_type_specialty,expertise_tier\n"


def instance(fleet_csv: str | None = None):
    files = {name: (DATA / name).read_bytes() for name in REQUIRED_HEADERS}
    if fleet_csv is not None:
        files["09_FLEET_DATA.csv"] = fleet_csv.encode()
    return parse_instance(files)


def scheduled_map(data, out):
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans = build_activity_plans(data, net, cal)
    by_act: dict[str, list] = {}
    for row in out.schedule_access:
        by_act.setdefault(row.activity_id, []).append(row)
    return net, {
        aid: {
            "access_nights": len(rows),
            "first_week": min(r.week for r in rows),
            "last_week": max(r.week for r in rows),
            "locations": plans[aid].path if aid in plans else [],
        }
        for aid, rows in by_act.items()
    }


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.data = load_instance_from_dir(str(DATA))
        self.coords = station_coordinates(self.data)

    def test_every_station_is_placed(self):
        self.assertEqual(
            set(self.coords), {s.station_id for s in self.data.stations}
        )

    def test_sequence_drives_distance_along_a_line(self):
        # S01..S04 are consecutive on ALP, so they must be evenly spaced
        gaps = [
            distance_km(self.coords[a], self.coords[b])
            for a, b in (("S01", "S02"), ("S02", "S03"), ("S03", "S04"))
        ]
        self.assertTrue(all(abs(g - gaps[0]) < 1e-9 for g in gaps))
        self.assertGreater(gaps[0], 0)

    def test_interchange_is_one_place_on_both_lines(self):
        # H01 sits on ALP and BET; it must resolve to a single averaged point
        self.assertEqual(len([s for s in self.data.stations if s.station_id == "H01"]), 2)
        x, y = self.coords["H01"]
        self.assertAlmostEqual(y, 2.0)  # midway between the two lines
        self.assertAlmostEqual(x, 10.0)

    def test_sector_point_is_the_midpoint_of_its_stations(self):
        point = location_point("SEC:ALP:S01_S02:EB", self.coords)
        self.assertEqual(point, centroid([self.coords["S01"], self.coords["S02"]]))

    def test_platform_point_is_its_station(self):
        self.assertEqual(location_point("PLAT:ALP:S03:WB", self.coords), self.coords["S03"])

    def test_unknown_location_is_none_not_a_crash(self):
        self.assertIsNone(location_point("NOPE:ALP:S01:EB", self.coords))
        self.assertIsNone(location_point("", self.coords))

    def test_spacing_parameters_scale_the_plane(self):
        self.data.parameters.extra["station_spacing_km"] = "10"
        wide = station_coordinates(self.data)
        self.assertAlmostEqual(
            distance_km(wide["S01"], wide["S02"]),
            distance_km(self.coords["S01"], self.coords["S02"]) * 4,
        )


class MatchingTests(unittest.TestCase):
    def test_tier_number_parses_every_spelling(self):
        for label, expected in (("Tier 1", 1), ("tier-2", 2), ("3", 3), ("Tier 10", 10)):
            self.assertEqual(tier_number(label), expected)
        self.assertEqual(tier_number("senior"), 99)  # unparseable sorts last

    def test_live_contracts_require_a_live_crew(self):
        act = Activity(
            activity_id="A1", contract_number="C1", activity_type="Renewal",
            start_location_id="SEC:ALP:S01_S02:EB", end_location_id="SEC:ALP:S01_S02:EB",
        )
        self.assertEqual(required_specialty(act, "Live"), "Live")
        self.assertEqual(required_specialty(act, "Non-live (Consist)"), "Renewal")

    def test_team_falls_back_to_its_base_station_without_coordinates(self):
        data = instance(FLEET_HEADER + "T1,S03,,,Renewal,Tier 1\n")
        site = resolve_fleet(data, station_coordinates(data))[0]
        self.assertFalse(site.explicit_coords)
        self.assertEqual(site.point, station_coordinates(data)["S03"])

    def test_explicit_coordinates_win_over_the_base_station(self):
        data = instance(FLEET_HEADER + "T1,S03,99,99,Renewal,Tier 1\n")
        site = resolve_fleet(data, station_coordinates(data))[0]
        self.assertTrue(site.explicit_coords)
        self.assertEqual(site.point, (99.0, 99.0))

    def test_unplaceable_team_is_rejected_at_load(self):
        with self.assertRaises(CsvSchemaError):
            instance(FLEET_HEADER + "T1,NOT_A_STATION,,,Renewal,Tier 1\n")

    def test_duplicate_team_ids_are_rejected(self):
        with self.assertRaises(CsvSchemaError):
            instance(FLEET_HEADER + "T1,S01,,,Renewal,Tier 1\nT1,S02,,,Renewal,Tier 1\n")

    def test_wrong_header_is_rejected(self):
        with self.assertRaises(CsvSchemaError):
            instance("team_id,base_station_id\nT1,S01\n")


class AllocationTests(unittest.TestCase):
    """End-to-end over the bundled instance and its bundled fleet."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_instance_from_dir(str(DATA))
        out = solve_baseline("A", cls.data)
        cls.net, cls.scheduled = scheduled_map(cls.data, out)
        cls.alloc = allocate_teams(cls.data, cls.net, cls.scheduled)

    def test_bundled_instance_ships_a_fleet(self):
        self.assertTrue(self.data.fleet)

    def test_every_scheduled_activity_gets_exactly_one_crew(self):
        ids = [r["activity_id"] for r in self.alloc["team_allocations"]]
        self.assertEqual(sorted(ids), sorted(self.scheduled))
        self.assertEqual(len(ids), len(set(ids)))

    def test_metrics_agree_with_the_rows_they_summarise(self):
        rows = self.alloc["team_allocations"]
        distances = [r["travel_distance_km"] for r in rows]
        self.assertAlmostEqual(self.alloc["avg_travel_distance"], round(sum(distances) / len(distances), 2), places=1)
        self.assertAlmostEqual(self.alloc["total_travel_distance"], round(sum(distances), 2), places=1)
        self.assertEqual(self.alloc["max_travel_distance"], max(distances))
        matched = sum(1 for r in rows if r["expertise_match"])
        self.assertAlmostEqual(self.alloc["expertise_match_rate"], round(matched / len(rows) * 100, 1), places=1)
        self.assertEqual(self.alloc["unmatched_expertise"], len(rows) - matched)

    def test_rates_are_percentages(self):
        for key in ("expertise_match_rate", "nearest_team_match_rate"):
            self.assertGreaterEqual(self.alloc[key], 0.0)
            self.assertLessEqual(self.alloc[key], 100.0)

    def test_assigned_crew_is_never_further_than_it_must_be(self):
        # the chosen crew can only lose to the nearest eligible one, never beat it
        for row in self.alloc["team_allocations"]:
            self.assertGreaterEqual(row["travel_distance_km"], row["closest_team_distance_km"] - 1e-9)
            self.assertEqual(row["closest_team_match"], row["team_id"] == row["closest_team_id"])
            self.assertAlmostEqual(
                row["detour_km"],
                round(row["travel_distance_km"] - row["closest_team_distance_km"], 2),
                places=2,
            )

    def test_crews_may_work_down_a_tier_but_never_up(self):
        for row in self.alloc["team_allocations"]:
            if row["tier_match"]:
                self.assertLessEqual(row["team_tier"], row["required_tier"])

    def test_match_percentage_tracks_its_two_components(self):
        for row in self.alloc["team_allocations"]:
            expected = (50 if row["specialty_match"] else 0) + (50 if row["tier_match"] else 0)
            self.assertEqual(row["expertise_match_pct"], expected)
            self.assertEqual(row["expertise_match"], expected == 100)

    def test_workload_cap_spreads_the_fleet(self):
        counts = {t["team_id"]: t["assignments"] for t in self.alloc["teams"]}
        self.assertEqual(sum(counts.values()), len(self.alloc["team_allocations"]))
        self.assertLessEqual(max(counts.values()), self.alloc["workload_cap"])
        self.assertGreater(self.alloc["teams_utilised"], 1)

    def test_allocation_is_deterministic(self):
        again = allocate_teams(self.data, self.net, self.scheduled)
        self.assertEqual(again["team_allocations"], self.alloc["team_allocations"])

    def test_no_fleet_yields_null_metrics_not_zeroes(self):
        data = instance()  # the 8 required files only
        self.assertEqual(data.fleet, [])
        alloc = allocate_teams(data, Network.build(data), self.scheduled)
        self.assertFalse(alloc["available"])
        self.assertEqual(alloc["team_allocations"], [])
        for key in ("avg_travel_distance", "expertise_match_rate", "nearest_team_match_rate"):
            self.assertIsNone(alloc[key], key)

    def test_a_single_crew_takes_everything_even_over_cap(self):
        # one team, wrong specialty for most work: nothing may go unallocated
        data = instance(FLEET_HEADER + "SOLO,S01,,,Renewal,Tier 3\n")
        alloc = allocate_teams(data, Network.build(data), self.scheduled)
        self.assertEqual(alloc["activities_allocated"], len(self.scheduled))
        self.assertEqual({r["team_id"] for r in alloc["team_allocations"]}, {"SOLO"})
        self.assertLess(alloc["expertise_match_rate"], 100.0)  # shortfalls stay visible

    def test_expertise_shortfall_is_reported_not_hidden(self):
        data = instance(FLEET_HEADER + "ONLY,S01,,,Signalling,Tier 3\n")
        alloc = allocate_teams(data, Network.build(data), self.scheduled)
        self.assertEqual(alloc["expertise_match_rate"], 0.0)
        self.assertEqual(alloc["unmatched_expertise"], alloc["activities_allocated"])
        self.assertTrue(all(not r["specialty_match"] for r in alloc["team_allocations"]))

    def test_nothing_scheduled_yields_an_empty_allocation(self):
        alloc = allocate_teams(self.data, self.net, {})
        self.assertEqual(alloc["team_allocations"], [])
        self.assertIsNone(alloc["avg_travel_distance"])
        self.assertTrue(alloc["available"])  # a fleet exists, there is just no work


if __name__ == "__main__":
    unittest.main()
