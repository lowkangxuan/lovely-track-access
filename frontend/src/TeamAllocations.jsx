import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Route,
  Search,
  Target,
  Users,
  X,
  XCircle,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 * Review Team Allocations — full-screen overlay                      *
 *   header : fleet-level summary metrics                             *
 *   body   : sortable / searchable / paginated allocation table      *
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 12;

const button =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/** `key` drives sorting; `numeric` right-aligns and compares as a number. */
const COLUMNS = [
  { key: "worksite_location_id", label: "Worksite / Location", width: "w-[22%]" },
  { key: "worksite_coords", label: "Worksite (X, Y)", numeric: true, width: "w-[11%]" },
  { key: "team_id", label: "Assigned team", width: "w-[15%]" },
  { key: "team_coords", label: "Team (X, Y)", numeric: true, width: "w-[11%]" },
  { key: "travel_distance_km", label: "Travel distance", numeric: true, width: "w-[11%]" },
  { key: "closest_team_match", label: "Closest team?", width: "w-[13%]" },
  { key: "expertise_match_pct", label: "Expertise tier & match", width: "w-[17%]" },
];

/** Values the table sorts on — the two coordinate columns sort by distance from the origin. */
function sortValue(row, key) {
  switch (key) {
    case "worksite_coords":
      return Math.hypot(row.worksite_x ?? 0, row.worksite_y ?? 0);
    case "team_coords":
      return Math.hypot(row.team_x ?? 0, row.team_y ?? 0);
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

        {/* ---------- filter bar ---------- */}
        <div className="shrink-0 flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-3">
          <div className="relative min-w-[240px] flex-1 max-w-sm">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              aria-label="Filter allocations by location or team"
              placeholder="Filter by location, team or activity…"
              className="w-full rounded-lg bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-200 ring-1 ring-slate-700 outline-none focus:ring-sky-500" />
          </div>
          {query && <button onClick={() => { setQuery(""); setPage(0); }} className="text-[11px] text-slate-400 hover:text-white">Clear</button>}
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
              <table className="w-full min-w-[980px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-slate-500">
                  <tr>{COLUMNS.map((c) => <SortHeader key={c.key} column={c} sort={sort} onSort={toggleSort} />)}</tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.activity_id} className="border-t border-slate-800 hover:bg-slate-950/50">
                      <td className="px-4 py-3">
                        <div className="font-mono text-[11px] text-slate-200">{r.worksite_location_id}</div>
                        <div className="mt-0.5 text-[10px] text-slate-500">
                          {r.contract_number}:{r.activity_id} · {r.activity_type} · P{r.activity_priority} · {r.worksite_locations} location{r.worksite_locations === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-300">{r.worksite_x}, {r.worksite_y}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-[11px] text-slate-200">{r.team_id}</div>
                        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
                          <MapPin className="h-2.5 w-2.5" /> {r.base_station_id} · {r.team_specialty}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-300">{r.team_x}, {r.team_y}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={r.travel_distance_km > (allocation?.avg_travel_distance ?? 0) * 2 ? "text-amber-300" : "text-slate-200"}>
                          {r.travel_distance_km.toFixed(2)} km
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <MatchBadge ok={r.closest_team_match} yes="Closest" no={`+${r.detour_km.toFixed(2)} km`} />
                        {!r.closest_team_match && (
                          <div className="mt-1 font-mono text-[10px] text-slate-500">{r.closest_team_id} @ {r.closest_team_distance_km} km</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <MatchBadge ok={r.expertise_match} yes={`${r.expertise_tier} · ${r.expertise_match_pct}% match`} no={`${r.expertise_tier} · ${r.expertise_match_pct}% match`} />
                        <div className="mt-1 text-[10px] text-slate-500">
                          Requires {r.required_tier_label} {r.required_specialty}
                        </div>
                      </td>
                    </tr>
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
