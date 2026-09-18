import test from "node:test";
import assert from "node:assert/strict";
import { activityPriority, calendarDays, isoDate, matches } from "./schedule-utils.js";

const task = {
  contract_number: "C001", contract_priority: 3, activity_priority: 1,
  location_id: "SEC:ALP:S01_S02:EB",
  locations: ["SEC:ALP:S01_S02:EB", "PLAT:ALP:S02:EB"],
};

test("priority filters use activity priority even when the contract has a different tier", () => {
  assert.equal(matches(task, " c001 ", "1", "S02"), true);
  assert.equal(matches(task, "", "3", ""), false);
  assert.equal(matches(task, "C002", "1", ""), false);
});

test("locations match occupied sectors, exact stations and lines without partial-ID collisions", () => {
  for (const location of ["ALP", "S01", "S02", "PLAT:ALP:S02:EB"]) {
    assert.equal(matches(task, "", "", location), true, location);
  }
  for (const location of ["BET", "S0", "S03", "PLAT:ALP:S02:WB"]) {
    assert.equal(matches(task, "", "", location), false, location);
  }
});

test("calendar priority colours remain independent of overrun and ECLO status", () => {
  const tones = [1, 2, 3].map((activity_priority) => activityPriority({ ...task, activity_priority }));
  assert.equal(new Set(tones.map((value) => value.tone)).size, 3);
  assert.equal(tones[0].label, "P1 · Highest");
  assert.equal(tones[2].label, "P3 · Lowest");
  assert.deepEqual(activityPriority({ ...task, eclo: 1, days_delayed: 21 }), tones[0]);
  assert.equal(activityPriority({}).label, "Priority unknown");
});

test("calendar aligns to Monday and includes leap day and year-boundary spillover", () => {
  const january = calendarDays("2027-01");
  assert.equal(january.length, 35);
  assert.equal(isoDate(january[0]), "2026-12-28");
  assert.equal(isoDate(january.at(-1)), "2027-01-31");
  assert.ok(calendarDays("2028-02").map(isoDate).includes("2028-02-29"));
  assert.equal(calendarDays("2027-05").length, 42);
});
