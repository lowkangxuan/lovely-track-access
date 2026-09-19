/**
 * Pure geometry + scale helpers for the team-allocation row visualisations.
 *
 * Kept out of the JSX so they can be unit-tested by `npm test`
 * (`node --test src/*.test.js` cannot import JSX).
 *
 * Coordinate convention
 * ---------------------
 * Allocation coordinates are cartesian kilometres: +X east, +Y north. SVG's y
 * axis grows downward, so anything plotted flips Y (`20 - dy * s`).
 */

/* ---- 1. proximity tiers ------------------------------------------- */

/** Distance bands, in kilometres. Ordered nearest-first; the last one is open-ended. */
export const PROXIMITY_TIERS = [
  {
    id: "close",
    label: "Close",
    max: 5,
    // fill is the saturated ramp step; pill is the surface + ink pair
    fill: "bg-emerald-500",
    pill: "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  },
  {
    id: "medium",
    label: "Medium",
    max: 12,
    fill: "bg-amber-500",
    pill: "bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  },
  {
    id: "far",
    label: "Outlier",
    max: Infinity,
    fill: "bg-rose-500",
    pill: "bg-rose-100 text-rose-800 border border-rose-300 font-bold dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
  },
];

/**
 * Band for a travel distance in km. Boundaries belong to the *lower* band:
 * 5.0 is Medium, 12.0 is Medium, 12.01 is an Outlier.
 */
export function proximityTier(km) {
  const value = Number.isFinite(km) ? km : 0;
  return PROXIMITY_TIERS.find((t) => value <= t.max) ?? PROXIMITY_TIERS[PROXIMITY_TIERS.length - 1];
}

/* ---- 2. distance fill bar ----------------------------------------- */

/**
 * Bar width as a percentage of the longest journey in the current dataset,
 * clamped to 0–100. A non-positive or missing `max` collapses every bar to 0
 * rather than dividing by zero.
 */
export function distanceFillPercent(km, max) {
  if (!Number.isFinite(km) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (km / max) * 100));
}

/* ---- 3. compass bearing ------------------------------------------- */

/**
 * Eight-point compass, indexed by `round(theta / 45) % 8` where theta is the
 * standard `atan2(dy, dx)` angle in degrees.
 *
 * NOTE the offset: atan2 measures anticlockwise from **east**, not north, so
 * index 0 is E and north lands at index 2. Mapping index 0 to N — the obvious
 * reading if you just list the eight points starting at north — rotates every
 * arrow on the table by 90 degrees.
 */
export const COMPASS = [
  { label: "E", arrow: "→" },
  { label: "NE", arrow: "↗" },
  { label: "N", arrow: "↑" },
  { label: "NW", arrow: "↖" },
  { label: "W", arrow: "←" },
  { label: "SW", arrow: "↙" },
  { label: "S", arrow: "↓" },
  { label: "SE", arrow: "↘" },
];

/** Marker for "the crew is already standing on the worksite". */
export const CO_LOCATED = { theta: 0, label: "on site", arrow: "•", coLocated: true };

/**
 * Direction from the worksite to the team.
 * `{ theta, label, arrow, coLocated }` — theta normalised to [0, 360).
 */
export function bearing(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return CO_LOCATED;
  if (dx === 0 && dy === 0) return CO_LOCATED;
  const theta = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { theta, ...COMPASS[Math.round(theta / 45) % 8], coLocated: false };
}

/* ---- 4. micro scatter plot ---------------------------------------- */

export const SVG_SIZE = 40;
export const SVG_CENTER = SVG_SIZE / 2;
/** Keeps the team dot (r=2.5) and its 1px ring clear of the viewBox edge. */
export const SVG_MAX_OFFSET = 16;

/**
 * Where to plot the team dot in a 40x40 viewBox whose centre is the worksite.
 *
 * Direction is exact; magnitude uses a **square-root scale** against the
 * dataset maximum. A linear scale would squash the bulk of the fleet — most
 * journeys are a few km against a 21 km outlier — into a dot indistinguishable
 * from the centre. Square root keeps short hops visible while staying
 * monotonic, so glyphs remain comparable between rows.
 *
 * Set `LINEAR_SCALE` to true for a plain linear mapping.
 */
export const LINEAR_SCALE = false;

export function spatialPoint(dx, dy, maxDistance) {
  const safeDx = Number.isFinite(dx) ? dx : 0;
  const safeDy = Number.isFinite(dy) ? dy : 0;
  const r = Math.hypot(safeDx, safeDy);
  if (r === 0) return { x: SVG_CENTER, y: SVG_CENTER, r: 0, offset: 0 };

  const max = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : r;
  const ratio = Math.min(1, r / max);
  const scaled = LINEAR_SCALE ? ratio : Math.sqrt(ratio);
  const offset = Math.min(SVG_MAX_OFFSET, SVG_MAX_OFFSET * scaled);

  return {
    x: SVG_CENTER + (safeDx / r) * offset,
    y: SVG_CENTER - (safeDy / r) * offset, // SVG y grows downward
    r,
    offset,
  };
}

/** Everything one row's visualisations need, from the row's raw fields. */
export function rowGeometry(row, maxDistance) {
  const dx = (row?.team_x ?? 0) - (row?.worksite_x ?? 0);
  const dy = (row?.team_y ?? 0) - (row?.worksite_y ?? 0);
  return {
    dx,
    dy,
    bearing: bearing(dx, dy),
    point: spatialPoint(dx, dy, maxDistance),
    tier: proximityTier(row?.travel_distance_km),
    fillPercent: distanceFillPercent(row?.travel_distance_km, maxDistance),
  };
}
