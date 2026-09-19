import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPASS,
  PROXIMITY_TIERS,
  SVG_CENTER,
  SVG_MAX_OFFSET,
  bearing,
  distanceFillPercent,
  proximityTier,
  rowGeometry,
  spatialPoint,
} from "./allocation-viz.js";

/* ---- proximity tiers ---------------------------------------------- */

test("proximity bands split at 5 km and 12 km", () => {
  assert.equal(proximityTier(0).id, "close");
  assert.equal(proximityTier(4.99).id, "close");
  assert.equal(proximityTier(5).id, "close", "5.0 belongs to the lower band");
  assert.equal(proximityTier(5.01).id, "medium");
  assert.equal(proximityTier(12).id, "medium", "12.0 belongs to the lower band");
  assert.equal(proximityTier(12.01).id, "far");
  assert.equal(proximityTier(21.25).id, "far");
});

test("proximity tier survives junk input", () => {
  for (const bad of [undefined, null, NaN, "nope"]) {
    assert.equal(proximityTier(bad).id, "close");
  }
});

test("every tier ships a fill and a pill class", () => {
  for (const tier of PROXIMITY_TIERS) {
    assert.match(tier.fill, /^bg-/);
    assert.ok(tier.pill.includes("dark:"), `${tier.id} needs dark-mode classes`);
  }
});

/* ---- fill bar ------------------------------------------------------ */

test("fill percent scales against the dataset maximum", () => {
  assert.equal(distanceFillPercent(21.25, 21.25), 100);
  assert.equal(distanceFillPercent(0, 21.25), 0);
  assert.ok(Math.abs(distanceFillPercent(10.625, 21.25) - 50) < 1e-9);
});

test("fill percent clamps at 100 and never goes negative", () => {
  assert.equal(distanceFillPercent(99, 21.25), 100);
  assert.equal(distanceFillPercent(-5, 21.25), 0);
});

test("fill percent refuses to divide by zero", () => {
  for (const max of [0, -1, undefined, NaN]) {
    assert.equal(distanceFillPercent(5, max), 0);
  }
});

/* ---- bearing ------------------------------------------------------- */

test("cardinal directions map to the right arrow", () => {
  // atan2 measures anticlockwise from EAST — the 90-degree trap
  assert.deepEqual(pick(bearing(1, 0)), ["E", "→"]);
  assert.deepEqual(pick(bearing(1, 1)), ["NE", "↗"]);
  assert.deepEqual(pick(bearing(0, 1)), ["N", "↑"]);
  assert.deepEqual(pick(bearing(-1, 1)), ["NW", "↖"]);
  assert.deepEqual(pick(bearing(-1, 0)), ["W", "←"]);
  assert.deepEqual(pick(bearing(-1, -1)), ["SW", "↙"]);
  assert.deepEqual(pick(bearing(0, -1)), ["S", "↓"]);
  assert.deepEqual(pick(bearing(1, -1)), ["SE", "↘"]);
});

const pick = (b) => [b.label, b.arrow];

test("theta is normalised to [0, 360)", () => {
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [-1, -0.0001], [3, -4]]) {
    const { theta } = bearing(dx, dy);
    assert.ok(theta >= 0 && theta < 360, `theta ${theta} out of range`);
  }
  assert.ok(Math.abs(bearing(0, -1).theta - 270) < 1e-9);
});

test("each 45-degree sector rounds to its own compass point", () => {
  for (let i = 0; i < 8; i++) {
    const rad = (i * 45 * Math.PI) / 180;
    const b = bearing(Math.cos(rad), Math.sin(rad));
    assert.equal(b.label, COMPASS[i].label, `sector ${i * 45}deg`);
  }
});

test("a co-located crew is flagged, not pointed at", () => {
  const b = bearing(0, 0);
  assert.equal(b.coLocated, true);
  assert.equal(b.label, "on site");
  assert.equal(bearing(NaN, 1).coLocated, true);
});

/* ---- micro scatter ------------------------------------------------- */

test("the worksite sits at the centre of the viewBox", () => {
  const p = spatialPoint(0, 0, 21.25);
  assert.deepEqual([p.x, p.y], [SVG_CENTER, SVG_CENTER]);
});

test("team dot stays inside the 40px box for every direction", () => {
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    // a wild outlier, far beyond the dataset max
    const p = spatialPoint(Math.cos(rad) * 500, Math.sin(rad) * 500, 21.25);
    assert.ok(p.x >= SVG_CENTER - SVG_MAX_OFFSET - 1e-9, `x underflow at ${deg}`);
    assert.ok(p.x <= SVG_CENTER + SVG_MAX_OFFSET + 1e-9, `x overflow at ${deg}`);
    assert.ok(p.y >= SVG_CENTER - SVG_MAX_OFFSET - 1e-9, `y underflow at ${deg}`);
    assert.ok(p.y <= SVG_CENTER + SVG_MAX_OFFSET + 1e-9, `y overflow at ${deg}`);
  }
});

test("SVG y is flipped so north plots upward", () => {
  const north = spatialPoint(0, 5, 21.25);
  const south = spatialPoint(0, -5, 21.25);
  assert.ok(north.y < SVG_CENTER, "north must sit above centre");
  assert.ok(south.y > SVG_CENTER, "south must sit below centre");
  assert.ok(Math.abs(north.x - SVG_CENTER) < 1e-9);
});

test("east plots right, west plots left", () => {
  assert.ok(spatialPoint(5, 0, 21.25).x > SVG_CENTER);
  assert.ok(spatialPoint(-5, 0, 21.25).x < SVG_CENTER);
});

test("offset grows monotonically with distance", () => {
  let previous = -1;
  for (const km of [0.5, 1, 2, 4, 8, 16, 21.25]) {
    const { offset } = spatialPoint(km, 0, 21.25);
    assert.ok(offset > previous, `offset must increase at ${km} km`);
    previous = offset;
  }
  assert.ok(Math.abs(previous - SVG_MAX_OFFSET) < 1e-9, "the longest journey reaches the edge");
});

test("short hops stay visible under the square-root scale", () => {
  // the whole reason for sqrt: a 2.5 km hop against a 21.25 km max
  const { offset } = spatialPoint(2.5, 0, 21.25);
  assert.ok(offset > 4, `2.5 km should be plottable, got ${offset.toFixed(2)}px`);
});

test("direction is exact regardless of the magnitude scale", () => {
  const p = spatialPoint(3, 4, 21.25); // 3-4-5 triangle
  const dxPlot = p.x - SVG_CENTER;
  const dyPlot = SVG_CENTER - p.y;
  assert.ok(Math.abs(dyPlot / dxPlot - 4 / 3) < 1e-9, "aspect of the vector must be preserved");
});

/* ---- row geometry -------------------------------------------------- */

test("rowGeometry derives deltas from worksite to team", () => {
  const g = rowGeometry(
    { worksite_x: 10, worksite_y: 2, team_x: 15, team_y: 6, travel_distance_km: 6.4 },
    21.25,
  );
  assert.equal(g.dx, 5);
  assert.equal(g.dy, 4);
  assert.equal(g.bearing.label, "NE");
  assert.equal(g.tier.id, "medium");
  assert.ok(g.fillPercent > 0 && g.fillPercent < 100);
});

test("rowGeometry tolerates a row with no coordinates", () => {
  const g = rowGeometry({}, 21.25);
  assert.equal(g.dx, 0);
  assert.equal(g.dy, 0);
  assert.equal(g.bearing.coLocated, true);
  assert.equal(g.point.x, SVG_CENTER);
  assert.equal(g.fillPercent, 0);
});
