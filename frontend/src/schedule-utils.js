export const EMPTY_FILTERS = { query: "", priority: "", location: "" };

export const ACTIVITY_PRIORITIES = {
  1: { label: "P1 · Highest", tone: "bg-rose-500/15 text-rose-300 ring-rose-500/40", dot: "bg-rose-400" },
  2: { label: "P2 · Medium", tone: "bg-amber-500/15 text-amber-300 ring-amber-500/40", dot: "bg-amber-400" },
  3: { label: "P3 · Lowest", tone: "bg-sky-500/15 text-sky-300 ring-sky-500/40", dot: "bg-sky-400" },
};

export const activityPriority = (task) => ACTIVITY_PRIORITIES[task.activity_priority] ?? {
  label: "Priority unknown", tone: "bg-slate-800 text-slate-300 ring-slate-600", dot: "bg-slate-400",
};

export const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const taskLocations = (task) => (task.locations?.length ? task.locations : [task.location_id]).filter(Boolean);

/** Directional bounds every sector and platform is tagged with. */
export const BOUNDS = ["EB", "WB"];

/** `SEC:ALP:S01_S02:EB` → { kind, line, segment, bound, stations }; null for anything else. */
export function parseLocation(id) {
  const [kind, line, segment, bound = ""] = String(id || "").split(":");
  if (!kind || !line || !segment) return null;
  return { kind, line, segment, bound, stations: segment.split("_") };
}

/**
 * Location filter tokens: a full location id, a station id (`S01`), a line
 * (`ALP`) or a directional track (`ALP:EB`).
 */
export function matches(task, query, priority, location) {
  const project = query.trim().toLowerCase();
  return (!project || task.contract_number.toLowerCase().includes(project))
    && (!priority || Number(task.activity_priority) === Number(priority))
    && (!location || taskLocations(task).some((id) => {
      if (id === location) return true;
      const ref = parseLocation(id);
      return !!ref && (ref.line === location || `${ref.line}:${ref.bound}` === location || ref.stations.includes(location));
    }));
}

/** Options for the location filter: whole lines, directional tracks, then every occupied location. */
export function locationOptions(tasks) {
  const locations = [...new Set(tasks.flatMap(taskLocations))].sort();
  const lines = [...new Set(locations.map((id) => parseLocation(id)?.line).filter(Boolean))].sort();
  const tracks = lines.flatMap((line) => BOUNDS.map((bound) => `${line}:${bound}`))
    .filter((track) => locations.some((id) => `${parseLocation(id).line}:${parseLocation(id).bound}` === track));
  return { locations, lines, tracks };
}

/**
 * The four directional track paths of the network: each line × EB/WB, with the
 * sector and platform location ids that live on that bound. Sectors come from
 * the payload when present, otherwise from consecutive stations in seq order.
 */
export function networkTracks(network) {
  const stations = network?.stations ?? [];
  const sectors = network?.sectors ?? [];
  return (network?.lines ?? []).map((line) => {
    const ordered = stations.filter((s) => s.line_code === line.line_code).sort((a, b) => a.seq - b.seq);
    const index = new Map(ordered.map((s, i) => [s.station_id, i]));
    const own = sectors.filter((s) => s.line_code === line.line_code);
    const edges = own.length
      ? own.map((s) => ({ sector_id: s.sector_id, from: s.from_station_id, to: s.to_station_id, is_shared: s.is_shared ?? 0, sector_kind: s.sector_kind ?? null }))
      : ordered.slice(1).map((to, i) => ({
          sector_id: `SEC:${line.line_code}:${ordered[i].station_id}_${to.station_id}`,
          from: ordered[i].station_id, to: to.station_id, is_shared: 0, sector_kind: null,
        }));
    const placed = edges
      .filter((e) => index.has(e.from) && index.has(e.to))
      .sort((a, b) => index.get(a.from) - index.get(b.from));
    return {
      ...line,
      stations: ordered,
      tracks: BOUNDS.map((bound) => ({
        id: `${line.line_code}:${bound}`,
        bound,
        sectors: placed.map((e) => ({ ...e, location_id: `${e.sector_id}:${bound}`, from_index: index.get(e.from), to_index: index.get(e.to) })),
        platforms: ordered.map((s, i) => ({ station_id: s.station_id, index: i, location_id: `PLAT:${line.line_code}:${s.station_id}:${bound}` })),
      })),
    };
  }).filter((line) => line.stations.length);
}

/**
 * Overlay sets for the map: every location occupied by `tasks`, and every
 * buffer-exclusion location that is closed but not itself occupied.
 */
export function occupancyOverlay(tasks) {
  const occupied = new Set(tasks.flatMap(taskLocations));
  const buffer = new Set(tasks.flatMap((t) => t.buffer_zone ?? []).filter((id) => !occupied.has(id)));
  return { occupied, buffer };
}

export function calendarDays(month) {
  const start = new Date(`${month}-01T00:00:00`);
  const offset = (start.getDay() + 6) % 7;
  const last = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + last) / 7) * 7 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), i - offset + 1));
}

/* ---- instance CSV validation (Editor's View) ---------------------- */

/** Map an uploaded filename onto one of the 8 schema names (exact, then suffix match). */
export function matchSchemaName(fileName, schemaNames) {
  const base = String(fileName || "").split(/[\/]/).pop().toLowerCase();
  return schemaNames.find((n) => n.toLowerCase() === base)
    ?? schemaNames.find((n) => base.endsWith(n.toLowerCase()))
    ?? null;
}

/** Client-side header check against the schema registry; `schemas[name]` is the required column list. */
export function validateHeaders(name, headers, schemas) {
  const required = schemas[name] ?? [];
  const missing = required.filter((h) => !headers.includes(h));
  return missing.length
    ? { ok: false, missing, message: `${name} is invalid. Required headers: ${required.join(", ")}. Missing: ${missing.join(", ")}.` }
    : { ok: true, missing: [], message: `${headers.length} columns` };
}
