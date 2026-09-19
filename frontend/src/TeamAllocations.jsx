import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Compass,
  MapPin,
  Route,
  Search,
  Target,
  Users,
  X,
  XCircle,
} from "lucide-react";

import {
  PROXIMITY_TIERS,
  SVG_CENTER,
  SVG_SIZE,
  rowGeometry,
} from "./allocation-viz.js";

/* ------------------------------------------------------------------ *
 * Review Team Allocations — full-screen overlay                      *
 *   header : fleet-level summary metrics                             *
 *   body   : sortable / searchable / paginated allocation table      *
 *            with per-row distance, bearing and spatial micro-viz    *
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 12;

const button =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/** `key` drives sorting; `numeric` right-aligns and compares as a number. */
const COLUMNS = [
  { key: "worksite_location_id", label: "Worksite / Location", width: "w-[24%]" },
  { key: "team_id", label: "Assigned team", width: "w-[17%]" },
  { key: "spatial", label: "Spatial relative position", width: "w-[17%]" },
  { key: "travel_distance_km", label: "Travel distance", numeric: true, width: "w-[15%]" },
  { key: "closest_team_match", label: "Closest team?", width: "w-[13%]" },
  { key: "expertise_match_pct", label: "Expertise tier & match", width: "w-[14%]" },
];

/** Values the table sorts on. */
function sortValue(row, key) {
  switch (key) {
    case "spatial":
      // compass bearing from worksite to crew — the new axis this column adds
      return rowGeometry(row, 1).bearing.theta;
    case "closest_team_match":
      return row.closest_team_match ? 1 : 0;
    case "expertise_match_pct":
      // worst matches first when ascending: match %, then tier
      return (row.expertise_match_pct ?? 0) * 10 - (row.team_tier ?? 0);
    default:
      return row[key];
  }
}

function SummaryCard({ icon: Icon, label, value, description, tone }) {
  return (
    <div className="rounded-xl bg-slate-950/60 ring-1 ring-slate-800 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone || "text-slate-100"}`}>{value}</div>
      {description && <div className="mt-0.5 text-[10px] text-slate-400">{description}</div>}
    </div>
  );
}

function SortHeader({ column, sort, onSort }) {
  const active = sort.key === column.key;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" className={`${column.width} px-4 py-3 font-normal ${column.numeric ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(column.key)}
        className={`inline-flex items-center gap-1.5 hover:text-slate-200 transition-colors ${active ? "text-sky-300" : ""}`}>
        {column.label} <Icon className="h-3 w-3 shrink-0" />
      </button>
    </th>
  );
}

function MatchBadge({ ok, yes, no }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 ${
      ok ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "bg-amber-500/15 text-amber-300 ring-amber-500/30"}`}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} {ok ? yes : no}
    </span>
  );
}

/**
 * Worksite at the centre, crew plotted by true bearing and scaled distance.
 * Purely decorative to a screen reader — the same facts are in the text beside
 * it — so the glyph is aria-hidden and the cell carries the description.
 */
function SpatialGlyph({ point, coLocated }) {
  return (
    <svg viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`} width={SVG_SIZE} height={SVG_SIZE}
      aria-hidden="true" focusable="false" className="shrink-0">
      {/* recessive centre rings: the worksite's own frame of reference */}
      <circle cx={SVG_CENTER} cy={SVG_CENTER} r="15.5" fill="none" stroke="#1e293b" strokeWidth="1" />
      <circle cx={SVG_CENTER} cy={SVG_CENTER} r="8" fill="none" stroke="#1e293b" strokeWidth="1" />
      {!coLocated && (
        <line x1={SVG_CENTER} y1={SVG_CENTER} x2={point.x} y2={point.y}
          stroke="#94A3B8" strokeWidth="1" strokeDasharray="2,2" />
      )}
      {/* worksite — fixed blue dot at the origin */}
      <circle cx={SVG_CENTER} cy={SVG_CENTER} r="3" fill="#3B82F6" />
      {/* crew — ringed in the surface colour so it stays legible when it overlaps */}
      <circle cx={point.x} cy={point.y} r="2.5" fill="#E2E8F0" stroke="#0f172a" strokeWidth="1" />
    </svg>
  );
}

/**
 * One allocation row.
 *
 * `memo` keeps rows that did not change from re-rendering when an unrelated
 * piece of modal state does (typing in the filter box, for instance), and the
 * `useMemo` inside keeps the trigonometry off the render path entirely.
 */
const AllocationRow = memo(function AllocationRow({ row, maxDistance }) {
  const geometry = useMemo(
    () => rowGeometry(row, maxDistance),
    [row, maxDistance],
  );
  const { dx, dy, bearing, point, tier, fillPercent } = geometry;

  const spatialDescription = bearing.coLocated
    ? `Crew based on the worksite`
    : `Crew lies ${bearing.label} of the worksite, ${row.travel_distance_km.toFixed(2)} km away`;

  return (
    <tr className="border-t border-slate-800 hover:bg-slate-950/50">
      {/* ---- worksite ---- */}
      <td className="px-4 py-3">
        <div className="font-mono text-[11px] text-slate-200">{row.worksite_location_id}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">
          {row.contract_number}:{row.activity_id} · {row.activity_type} · P{row.activity_priority} · {row.worksite_locations} location{row.worksite_locations === 1 ? "" : "s"}
        </div>
      </td>

      {/* ---- crew ---- */}
      <td className="px-4 py-3">
        <div className="font-mono text-[11px] text-slate-200">{row.team_id}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
          <MapPin className="h-2.5 w-2.5" /> {row.base_station_id} · {row.team_specialty}
        </div>
      </td>

      {/* ---- spatial relative position ---- */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5" title={spatialDescription}>
          <SpatialGlyph point={point} coLocated={bearing.coLocated} />
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1 tabular-nums text-[11px] text-slate-200">
              <span aria-hidden="true" className="text-sm text-slate-400">{bearing.arrow}</span>
              <span>{bearing.label}</span>
            </div>
            <div className="mt-0.5 text-[10px] tabular-nums text-slate-500">
              site {row.worksite_x}, {row.worksite_y}
            </div>
            <div className="text-[10px] tabular-nums text-slate-500">
              crew {row.team_x}, {row.team_y}
            </div>
            <span className="sr-only">
              {spatialDescription}. Offset {dx.toFixed(2)} km east, {dy.toFixed(2)} km north.
            </span>
          </div>
        </div>
      </td>

      {/* ---- travel distance: pill + fill bar ---- */}
      <td className="px-4 py-3">
        <div className="flex flex-col items-end">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] tabular-nums ${tier.pill}`}>
            {row.travel_distance_km.toFixed(2)} km
          </span>
          <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden mt-1"
            role="img" aria-label={`${fillPercent.toFixed(0)} percent of the longest journey in this schedule`}>
            <div className={`h-full rounded-full transition-all duration-300 ${tier.fill}`}
              style={{ width: `${fillPercent}%` }} />
          </div>
        </div>
      </td>

      {/* ---- proximity to the nearest eligible crew ---- */}
      <td className="px-4 py-3">
        <MatchBadge ok={row.closest_team_match} yes="Closest" no={`+${row.detour_km.toFixed(2)} km`} />
        {!row.closest_team_match && (
          <div className="mt-1 font-mono text-[10px] text-slate-500">{row.closest_team_id} @ {row.closest_team_distance_km} km</div>
        )}
      </td>

      {/* ---- expertise ---- */}
      <td className="px-4 py-3">
        <MatchBadge ok={row.expertise_match}
          yes={`${row.expertise_tier} · ${row.expertise_match_pct}% match`}
          no={`${row.expertise_tier} · ${row.expertise_match_pct}% match`} />
        <div className="mt-1 text-[10px] text-slate-500">
          Requires {row.required_tier_label} {row.required_specialty}
        </div>
      </td>
    </tr>
  );
});

/**
 * `allocation` is the backend's `allocation` block:
 * { teams_total, avg_travel_distance, expertise_match_rate, nearest_team_match_rate, team_allocations: [...] }
 */
export default function TeamAllocationsModal({ allocation, scenario, onClose }) {
  const ref = useRef(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: "travel_distance_km", dir: "desc" });
  const [page, setPage] = useState(0);

  const rows = allocation?.team_allocations ?? [];

  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);

  /**
   * Every bar and glyph is scaled against the longest journey in the run, so
   * rows stay comparable. Falls back to the rows themselves if the backend
   * did not report a maximum.
   */
  const maxDistance = useMemo(() => {
    if (Number.isFinite(allocation?.max_travel_distance) && allocation.max_travel_distance > 0) {
      return allocation.max_travel_distance;
    }
    return rows.reduce((max, r) => Math.max(max, r.travel_distance_km ?? 0), 0);
  }, [allocation, rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.worksite_location_id, r.worksite_label, r.team_id, r.base_station_id, r.activity_id, r.contract_number]
        .some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, query]);

  const sorted = useMemo(() => {
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === bv) return String(a.activity_id).localeCompare(String(b.activity_id));
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = sorted.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const toggleSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "travel_distance_km" ? "desc" : "asc" }));
    setPage(0);
  };

  return (
    <dialog ref={ref} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="allocations-title"
      className="m-auto h-[92vh] w-[calc(100%-2rem)] max-w-[1500px] rounded-2xl bg-slate-900 p-0 text-slate-100 ring-1 ring-slate-700 shadow-2xl backdrop:bg-slate-950/85 backdrop:backdrop-blur-sm">
      <div className="flex h-full flex-col">
        {/* ---------- header ---------- */}
        <div className="shrink-0 border-b border-slate-800 px-6 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30">
              <Users className="h-4 w-4 text-sky-300" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="allocations-title" className="text-base font-medium">Team allocations</h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Closest eligible crew per scheduled worksite{scenario ? ` · Scenario ${scenario}` : ""} · distances are straight-line on the reconstructed network plane
              </p>
            </div>
            <button onClick={onClose} aria-label="Close team allocations" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 grid gap-2 grid-cols-2 lg:grid-cols-4">
            <SummaryCard icon={Users} label="Total teams" value={allocation?.teams_total ?? "—"}
              description={`${allocation?.teams_utilised ?? 0} deployed · ${allocation?.activities_allocated ?? 0} worksites`} />
            <SummaryCard icon={Target} label="Nearest-team match" value={allocation?.nearest_team_match_rate != null ? `${allocation.nearest_team_match_rate}%` : "—"}
              tone="text-sky-300"
              description={`${rows.filter((r) => !r.closest_team_match).length} rebalanced for workload`} />
            <SummaryCard icon={Route} label="Avg travel distance" value={allocation?.avg_travel_distance != null ? `${allocation.avg_travel_distance} km` : "—"}
              description={allocation?.total_travel_distance != null ? `${allocation.total_travel_distance} km total · ${allocation.max_travel_distance} km longest` : null} />
            <SummaryCard icon={CheckCircle2} label="Expertise match rate" value={allocation?.expertise_match_rate != null ? `${allocation.expertise_match_rate}%` : "—"}
              tone={allocation?.unmatched_expertise ? "text-amber-300" : "text-emerald-300"}
              description={allocation?.unmatched_expertise ? `${allocation.unmatched_expertise} assignment${allocation.unmatched_expertise === 1 ? "" : "s"} below requirement` : "Every crew meets specialty and tier"} />
          </div>
        </div>

        {/* ---------- filter bar + legend ---------- */}
        <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-3">
          <div className="relative min-w-[240px] flex-1 max-w-sm">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              aria-label="Filter allocations by location or team"
              placeholder="Filter by location, team or activity…"
              className="w-full rounded-lg bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-200 ring-1 ring-slate-700 outline-none focus:ring-sky-500" />
          </div>
          {query && <button onClick={() => { setQuery(""); setPage(0); }} className="text-[11px] text-slate-400 hover:text-white">Clear</button>}

          {/* the distance bands the pills and bars encode, named rather than colour-only */}
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1"><Compass className="h-3 w-3" /> bearing from site to crew</span>
            {PROXIMITY_TIERS.map((tier, i) => (
              <span key={tier.id} className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-4 rounded-full ${tier.fill}`} />
                {tier.label}
                <span className="text-slate-600">
                  {i === 0 ? "< 5 km" : i === 1 ? "5–12 km" : "> 12 km"}
                </span>
              </span>
            ))}
          </div>

          <span className="ml-auto text-[11px] text-slate-500" aria-live="polite">
            {sorted.length} of {rows.length} allocation{rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* ---------- table ---------- */}
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin px-6 py-4">
          {rows.length === 0 ? (
            <div className="grid h-full place-items-center text-center">
              <div>
                <Users className="mx-auto h-8 w-8 text-slate-600" />
                <p className="mt-3 text-sm text-slate-300">No team allocations for this run</p>
                <p className="mt-1 text-[11px] text-slate-500">Upload 09_FLEET_DATA.csv and preview again to allocate crews.</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl ring-1 ring-slate-800">
              <table className="w-full min-w-[1040px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-slate-500">
                  <tr>{COLUMNS.map((c) => <SortHeader key={c.key} column={c} sort={sort} onSort={toggleSort} />)}</tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <AllocationRow key={r.activity_id} row={r} maxDistance={maxDistance} />
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={COLUMNS.length} className="px-4 py-10 text-center text-slate-400">No allocation matches “{query}”.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------- pagination ---------- */}
        <div className="shrink-0 flex flex-wrap items-center gap-3 border-t border-slate-800 px-6 py-3">
          <p className="text-[11px] text-slate-500">
            Crews may work down a tier, never up · a non-closest match means workload balancing moved the job
          </p>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-slate-400 tabular-nums">Page {current + 1} of {pageCount}</span>
            <button className={`${button} !py-1.5`} onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={current === 0} aria-label="Previous page">
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button className={`${button} !py-1.5`} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={current >= pageCount - 1} aria-label="Next page">
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
