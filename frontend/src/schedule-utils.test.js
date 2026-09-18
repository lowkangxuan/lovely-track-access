import test from "node:test";
import assert from "node:assert/strict";
import { activityPriority, calendarDays, isoDate, locationOptions, matches, matchSchemaName, networkTracks, occupancyOverlay, parseLocation, validateHeaders } from "./schedule-utils.js";

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

test("directional track tokens filter by line and bound", () => {
  assert.equal(matches(task, "", "", "ALP:EB"), true);
  assert.equal(matches(task, "", "", "ALP:WB"), false);
  assert.equal(matches(task, "", "", "BET:EB"), false);
  assert.deepEqual(parseLocation("SEC:BET:H01_H02:WB"), { kind: "SEC", line: "BET", segment: "H01_H02", bound: "WB", stations: ["H01", "H02"] });
  assert.equal(parseLocation("S01"), null);
  assert.deepEqual(locationOptions([task, { ...task, location_id: "PLAT:BET:S11:WB", locations: ["PLAT:BET:S11:WB"] }]), {
    locations: ["PLAT:ALP:S02:EB", "PLAT:BET:S11:WB", "SEC:ALP:S01_S02:EB"],
    lines: ["ALP", "BET"],
    tracks: ["ALP:EB", "BET:WB"],
  });
});

const network = {
  lines: [{ line_code: "ALP", line_name: "Line Alpha" }, { line_code: "BET", line_name: "Line Beta" }],
  stations: [
    { station_id: "S02", line_code: "ALP", seq: 2, is_interchange: 0 },
    { station_id: "S01", line_code: "ALP", seq: 1, is_interchange: 0 },
    { station_id: "H01", line_code: "ALP", seq: 3, is_interchange: 1 },
    { station_id: "H01", line_code: "BET", seq: 2, is_interchange: 1 },
    { station_id: "S11", line_code: "BET", seq: 1, is_interchange: 0 },
  ],
};

test("network tracks expand every line into EB and WB paths with bound-tagged sectors and platforms", () => {
  const [alpha, beta] = networkTracks(network);
  assert.deepEqual(alpha.stations.map((s) => s.station_id), ["S01", "S02", "H01"]);
  assert.deepEqual(alpha.tracks.map((t) => t.id), ["ALP:EB", "ALP:WB"]);
  assert.deepEqual(alpha.tracks[0].sectors.map((s) => s.location_id), ["SEC:ALP:S01_S02:EB", "SEC:ALP:S02_H01:EB"]);
  assert.deepEqual(alpha.tracks[1].sectors.map((s) => s.location_id), ["SEC:ALP:S01_S02:WB", "SEC:ALP:S02_H01:WB"]);
  assert.deepEqual(alpha.tracks[1].platforms.map((p) => p.location_id), ["PLAT:ALP:S01:WB", "PLAT:ALP:S02:WB", "PLAT:ALP:H01:WB"]);
  assert.deepEqual(beta.tracks[0].sectors.map((s) => [s.location_id, s.from_index, s.to_index]), [["SEC:BET:S11_H01:EB", 0, 1]]);
});

test("network tracks prefer sectors from the payload and drop ones that reference unknown stations", () => {
  const sectors = [
    { sector_id: "SEC:ALP:S02_H01", line_code: "ALP", from_station_id: "S02", to_station_id: "H01", seq: 2, is_shared: 1 },
    { sector_id: "SEC:ALP:S01_S02", line_code: "ALP", from_station_id: "S01", to_station_id: "S02", seq: 1, is_shared: 0 },
    { sector_id: "SEC:ALP:H01_S09", line_code: "ALP", from_station_id: "H01", to_station_id: "S09", seq: 3, is_shared: 0 },
  ];
  sectors[0].sector_kind = "viaduct";
  const [alpha] = networkTracks({ ...network, sectors });
  assert.deepEqual(alpha.tracks[0].sectors.map((s) => [s.location_id, s.is_shared]), [["SEC:ALP:S01_S02:EB", 0], ["SEC:ALP:S02_H01:EB", 1]]);
  assert.deepEqual(alpha.tracks[1].sectors.map((s) => s.sector_kind), [null, "viaduct"]);
  assert.deepEqual(networkTracks(null), []);
});

test("occupancy overlay separates occupied locations from the buffer exclusion ring", () => {
  const { occupied, buffer } = occupancyOverlay([
    { ...task, buffer_zone: ["SEC:ALP:S01_S02:EB", "SEC:ALP:S01_S02:WB", "PLAT:ALP:S01:EB"] },
    { location_id: "PLAT:BET:S11:WB", locations: [], buffer_zone: ["PLAT:ALP:S01:EB", "SEC:BET:S11_S12:WB"] },
  ]);
  assert.deepEqual([...occupied].sort(), ["PLAT:ALP:S02:EB", "PLAT:BET:S11:WB", "SEC:ALP:S01_S02:EB"]);
  assert.deepEqual([...buffer].sort(), ["PLAT:ALP:S01:EB", "SEC:ALP:S01_S02:WB", "SEC:BET:S11_S12:WB"]);
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

test("editor validates uploaded headers against the schema registry and routes files by name", () => {
  const schemas = { "01_LINES.csv": ["line_code", "line_name"], "06_PARAMETERS.csv": ["key", "value"] };
  const names = Object.keys(schemas);
  assert.equal(matchSchemaName("01_LINES.csv", names), "01_LINES.csv");
  assert.equal(matchSchemaName("C:\exports\instance_06_parameters.CSV", names), "06_PARAMETERS.csv");
  assert.equal(matchSchemaName("RESULTS.csv", names), null);
  assert.deepEqual(validateHeaders("01_LINES.csv", ["line_name", "line_code", "extra"], schemas), { ok: true, missing: [], message: "3 columns" });
  const bad = validateHeaders("01_LINES.csv", ["line_code"], schemas);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ["line_name"]);
  assert.equal(bad.message, "01_LINES.csv is invalid. Required headers: line_code, line_name. Missing: line_name.");
});

test("editor drafts round-trip through storage with File objects rebuilt", async () => {
  const { serializeDraft, deserializeDraft, saveDraft, loadDraft, DRAFT_KEY } = await import("./draft-store.js");
  const file = new File(["line_code,line_name\nALP,Alpha\n"], "my_01_LINES.csv", { type: "text/csv" });
  const draft = { entries: { "01_LINES.csv": { file, ok: true, rowCount: 1, message: "2 columns" } }, scenario: "B", weatherAware: true };
  const stored = await serializeDraft(draft);
  assert.equal(stored.entries["01_LINES.csv"].text, "line_code,line_name\nALP,Alpha\n");
  const back = deserializeDraft(stored);
  assert.equal(back.scenario, "B");
  assert.equal(back.weatherAware, true);
  assert.equal(back.entries["01_LINES.csv"].file.name, "my_01_LINES.csv");
  assert.equal(await back.entries["01_LINES.csv"].file.text(), "line_code,line_name\nALP,Alpha\n");
  const memory = new Map();
  const storage = { setItem: (k, v) => memory.set(k, v), getItem: (k) => memory.get(k) ?? null, removeItem: (k) => memory.delete(k) };
  assert.equal(await saveDraft(draft, storage), true);
  assert.ok(memory.has(DRAFT_KEY));
  assert.equal(loadDraft(storage).entries["01_LINES.csv"].ok, true);
  assert.equal(loadDraft({ getItem: () => "not json" }), null);
});
