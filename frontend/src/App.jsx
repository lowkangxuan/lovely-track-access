import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  CloudLightning,
  CloudRain,
  CloudRainWind,
  Sun,
  Gauge,
  KeyRound,
  Layers,
  Link2,
  LogOut,
  MapPin,
  Moon,
  RefreshCw,
  Shield,
  TrainFront,
  UserRound,
  X,
} from "lucide-react";

import EditorView from "./EditorView.jsx";
import { loadDraft, saveDraft } from "./draft-store.js";
import Metric from "./Metric.jsx";
import TrackMap from "./TrackMap.jsx";
import { Dialog, KdaDialog, LocationMap, MonthlyView, ScheduleToolbar, SearchDialog } from "./ScheduleControls.jsx";
import { activityPriority, EMPTY_FILTERS, matches, occupancyOverlay } from "./schedule-utils.js";

/* ------------------------------------------------------------------ *
 * Configuration                                                      *
 * ------------------------------------------------------------------ */

// Empty = same origin. In production FastAPI serves this bundle itself; in dev
// Vite proxies /api to uvicorn on :8000 (see vite.config.js).
const API_BASE = import.meta.env?.VITE_API_BASE ?? "";
const API_LABEL = API_BASE || "this origin";

/** Hardcoded demo credentials + RBAC scope. */
const USERS = {
  admin: {
    password: "admin123",
    role: "admin",
    displayName: "Network Access Controller",
    // null == every contract in the instance
    contracts: null,
  },
  eng1: {
    password: "pass123",
    role: "engineer",
    displayName: "Site Engineer — C001",
    contracts: ["C001"],
  },
};

/** Solver output CSVs exposed by GET /api/download/{scenario}/{file}. */
const OUTPUT_FILES = ["SCHEDULE_ACCESS.csv", "SCHEDULE_OCCUPANCY.csv", "RESULTS.csv"];

/** Mirror of the backend schema registry; refreshed from GET /api/schemas at boot. */
const FALLBACK_HEADERS = {
  "01_LINES.csv": ["line_code", "line_name"],
  "02_STATIONS.csv": ["station_id", "line_code", "seq", "is_interchange"],
  "03_SECTORS.csv": ["sector_id", "line_code", "from_station_id", "to_station_id", "seq", "is_shared"],
  "04_LOCATION_SUPPLY.csv": ["location_id", "location_kind", "line_code", "bound", "supply_capacity"],
  "05_BUFFER_LOCATION.csv": ["nature_of_works", "up_to_buffer_sectors", "opposite_bound_required"],
  "06_PARAMETERS.csv": ["key", "value"],
  "07_PROJECT_DETAILS.csv": [
    "contract_number", "contract_description", "contract_award_date", "activity_type",
    "nature_of_activity", "contract_priority", "contract_completion_date",
    "planned_completion_date", "number_of_workfronts", "access_type",
    "number_of_maximum_access_per_week",
  ],
  "08_ACTIVITY_DETAILS.csv": [
    "activity_id", "contract_number", "activity_type", "start_location_id",
    "end_location_id", "total_accesses", "planned_start_date",
    "predecessor_activity_id", "activity_priority",
  ],
};

/** Optional instance files — uploaded when available, never required to preview. */
const FALLBACK_OPTIONAL_HEADERS = {
  "09_FLEET_DATA.csv": [
    "team_id", "base_station_id", "coord_x", "coord_y",
    "activity_type_specialty", "expertise_tier",
  ],
};

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */

const fmtDate = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

const fmtShort = (iso) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";

const priorityTone = (p) =>
  p === 1 ? "bg-rose-500/15 text-rose-300 ring-rose-500/30"
  : p === 2 ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
  : "bg-slate-500/15 text-slate-300 ring-slate-500/30";

const delayTone = (d) =>
  d > 28 ? "text-rose-300" : d > 0 ? "text-amber-300" : "text-emerald-300";

/* ------------------------------------------------------------------ *
 * Login                                                              *
 * ------------------------------------------------------------------ */

function Login({ onLogin, apiOnline }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const record = USERS[username.trim().toLowerCase()];
    if (!record || record.password !== password) {
      setError("Invalid credentials. Try admin / admin123 or eng1 / pass123.");
      return;
    }
    setError("");
    onLogin({ username: username.trim().toLowerCase(), ...record });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-11 w-11 rounded-xl bg-sky-500/15 ring-1 ring-sky-400/30 grid place-items-center">
            <TrainFront className="h-6 w-6 text-sky-300" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Track Access Scheduler</h1>
            <p className="text-xs text-slate-400">Line Alpha · Line Beta — possession planning</p>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-2xl bg-slate-900/70 ring-1 ring-slate-800 p-6 space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wide text-slate-400">Username</label>
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950 ring-1 ring-slate-800 focus:ring-sky-500 outline-none px-3 py-2 text-sm"
              placeholder="admin"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-slate-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950 ring-1 ring-slate-800 focus:ring-sky-500 outline-none px-3 py-2 text-sm"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-xs text-rose-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-px" /> {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-medium text-sm py-2.5 transition-colors flex items-center justify-center gap-2"
          >
            <KeyRound className="h-4 w-4" /> Sign in
          </button>

          <div className="pt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
            <div className="rounded-lg bg-slate-950/60 ring-1 ring-slate-800 px-3 py-2">
              <div className="font-medium text-slate-200 flex items-center gap-1.5"><Shield className="h-3 w-3" /> admin</div>
              admin123 — all contracts
            </div>
            <div className="rounded-lg bg-slate-950/60 ring-1 ring-slate-800 px-3 py-2">
              <div className="font-medium text-slate-200 flex items-center gap-1.5"><UserRound className="h-3 w-3" /> eng1</div>
              pass123 — C001 only
            </div>
          </div>
        </form>

        <p className={`mt-4 text-[11px] flex items-center gap-1.5 ${apiOnline ? "text-emerald-400" : "text-amber-400"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${apiOnline ? "bg-emerald-400" : "bg-amber-400"}`} />
          {apiOnline ? `Scheduler API reachable at ${API_LABEL}` : `Scheduler API unreachable at ${API_LABEL} — start the FastAPI backend`}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sticky timeline strip                                              *
 * ------------------------------------------------------------------ */

/** Daily outlook glyphs: condition -> icon + tone (severe conditions are heavy_rain / thunderstorm). */
const WEATHER_GLYPHS = {
  sun: { icon: Sun, tone: "text-amber-300/90", label: "Sun" },
  rain: { icon: CloudRain, tone: "text-sky-300/90", label: "Rain" },
  heavy_rain: { icon: CloudRainWind, tone: "text-rose-300", label: "Heavy rain · severe" },
  thunderstorm: { icon: CloudLightning, tone: "text-violet-300", label: "Thunderstorm · severe" },
};

/** Group outlook days by horizon week (week 1 starts on horizon.start). */
function weatherByWeek(weather, horizon) {
  const byWeek = new Map();
  if (!weather?.days?.length || !horizon?.start) return byWeek;
  const start = new Date(`${horizon.start}T00:00:00`);
  weather.days.forEach((d) => {
    const week = Math.floor((new Date(`${d.date}T00:00:00`) - start) / (7 * 86400000)) + 1;
    if (week < 1) return;
    byWeek.set(week, [...(byWeek.get(week) ?? []), d]);
  });
  return byWeek;
}

function TimelineStrip({ tasks, horizon, weather, activeWeek, onPickWeek }) {
  const buckets = useMemo(() => {
    const weeks = new Map();
    let max = horizon?.weeks ?? 30;
    tasks.forEach((t) => { max = Math.max(max, t.week); });
    for (let w = 1; w <= max; w += 1) weeks.set(w, { week: w, count: 0, eclo: 0, delayed: 0, date: null });
    tasks.forEach((t) => {
      const b = weeks.get(t.week);
      if (!b) return;
      b.count += 1;
      if (t.eclo) b.eclo += 1;
      if (t.days_delayed > 0) b.delayed += 1;
      b.date = b.date || t.date;
    });
    return [...weeks.values()];
  }, [tasks, horizon]);
  const days = useMemo(() => weatherByWeek(weather, horizon), [weather, horizon]);
  const showWeather = days.size > 0;

  const peak = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1 scrollbar-thin">
      {buckets.map((b) => {
        const height = b.count ? 6 + Math.round((b.count / peak) * 26) : 3;
        const isActive = b.week === activeWeek;
        const tone = b.count === 0 ? "bg-slate-800"
          : b.delayed ? "bg-rose-400/80"
          : b.eclo ? "bg-amber-400/80"
          : "bg-sky-400/80";
        const outlook = days.get(b.week) ?? [];
        const severe = outlook.filter((d) => d.severe).length;
        return (
          <button
            key={b.week}
            onClick={() => onPickWeek(b.week)}
            title={`Week ${b.week}${b.date ? ` · ${fmtShort(b.date)}` : ""} — ${b.count} access-night${b.count === 1 ? "" : "s"}${b.eclo ? `, ${b.eclo} ECLO` : ""}${severe ? ` · ${severe} severe weather day${severe === 1 ? "" : "s"}` : ""}`}
            className={`group shrink-0 ${showWeather ? "w-[58px]" : "w-[18px]"} flex flex-col items-center justify-end gap-1 rounded-md px-0.5 py-1 transition-colors ${
              isActive ? "bg-slate-800 ring-1 ring-sky-500/50" : "hover:bg-slate-800/60"
            }`}
          >
            {showWeather && (
              <span className="flex items-center gap-px h-2.5" aria-label={`Week ${b.week} weather`}>
                {outlook.map((d) => {
                  const glyph = WEATHER_GLYPHS[d.condition] ?? WEATHER_GLYPHS.sun;
                  const Icon = glyph.icon;
                  return <Icon key={d.date} className={`h-2 w-2 shrink-0 ${glyph.tone}`} aria-hidden="true">
                    <title>{`${fmtShort(d.date)} · ${glyph.label}${d.precipitation_mm ? ` · ${d.precipitation_mm} mm` : ""}`}</title>
                  </Icon>;
                })}
              </span>
            )}
            <span className={`w-[10px] rounded-sm ${tone}`} style={{ height }} />
            <span className={`text-[9px] leading-none ${isActive ? "text-sky-300" : "text-slate-500 group-hover:text-slate-300"}`}>
              {b.week}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Task card — minimalist 3-column                                    *
 * ------------------------------------------------------------------ */

function TaskCard({ task, onOpen, registerRef }) {
  return (
    <button
      ref={(el) => registerRef(task.week, el)}
      onClick={() => onOpen(task)}
      className="group shrink-0 w-full min-w-0 text-left rounded-xl bg-slate-900/80 hover:bg-slate-900 ring-1 ring-slate-800 hover:ring-sky-500/40 transition-all px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        {/* Left — contract : activity */}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Contract · Activity</div>
          <div className="font-mono text-sm text-slate-100 truncate">
            {task.contract_number}<span className="text-slate-500">:</span>{task.activity_id}
          </div>
        </div>

        {/* Center — location */}
        <div className="min-w-0 flex-[1.4] border-x border-slate-800 px-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
            <MapPin className="h-2.5 w-2.5" /> Location
          </div>
          <div className="font-mono text-[11px] text-sky-300 truncate" title={task.location_id}>
            {task.location_id}
          </div>
        </div>

        {/* Right — date / week */}
        <div className="min-w-0 flex-1 text-right">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Date · Week</div>
          <div className="text-sm text-slate-100 tabular-nums">{fmtShort(task.date)}</div>
          <div className="text-[10px] text-slate-500">Wk {task.week}</div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 text-[10px]">
        <span className={`rounded px-1.5 py-0.5 ring-1 ${priorityTone(task.contract_priority)}`}>
          Contract P{task.contract_priority}
        </span>
        <span className={`rounded px-1.5 py-0.5 ring-1 ${activityPriority(task).tone}`}>
          Activity P{task.activity_priority}
        </span>
        <span className="rounded px-1.5 py-0.5 bg-slate-800 text-slate-300">{task.access_type}</span>
        {task.eclo === 1 && (
          <span className="rounded px-1.5 py-0.5 bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30 flex items-center gap-1">
            <Moon className="h-2.5 w-2.5" /> ECLO
          </span>
        )}
        {task.days_delayed > 0 && (
          <span className="rounded px-1.5 py-0.5 bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30">
            +{task.days_delayed}d
          </span>
        )}
        <span className="ml-auto text-slate-600 group-hover:text-sky-400 transition-colors flex items-center">
          Detail <ChevronRight className="h-3 w-3" />
        </span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Activity detail modal                                              *
 * ------------------------------------------------------------------ */

const Field = ({ label, value, mono = false, tone = "" }) => (
  <div className="min-w-0">
    <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    <div className={`text-sm break-words ${mono ? "font-mono text-[12px]" : ""} ${tone || "text-slate-200"}`}>
      {value === null || value === undefined || value === "" ? "—" : value}
    </div>
  </div>
);


function ActivityModal({ task, network, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task) return null;
  const overlay = occupancyOverlay([task]);

  return (
    <div className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-slate-900 ring-1 ring-slate-800 shadow-2xl my-auto">
        {/* header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-800">
          <div className="h-9 w-9 rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30 grid place-items-center shrink-0">
            <ClipboardList className="h-4 w-4 text-sky-300" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-mono text-base text-slate-100">
              {task.contract_number}<span className="text-slate-500">:</span>{task.activity_id}
              <span className="ml-2 text-xs text-slate-500">access {task.access_seq} of {task.access_nights_used}</span>
            </h2>
            <p className="text-xs text-slate-400 truncate">{task.activity_description}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[72vh] overflow-y-auto">
          {/* Schedule metrics */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Schedule metrics</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Metric icon={CalendarDays} label="Scheduled date" value={fmtShort(task.date)} />
              <Metric icon={Clock} label="Week" value={`Wk ${task.week}`} />
              <Metric icon={Moon} label="Access nights" value={`${task.access_nights_used} / ${task.total_accesses}`} />
              <Metric
                icon={Gauge}
                label="Days delayed"
                value={task.days_delayed > 0 ? `+${task.days_delayed}d` : "On target"}
                tone={delayTone(task.days_delayed)}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Field label="Access night index" value={`Night ${task.access_night}`} />
              <Field label="ECLO" value={task.eclo === 1 ? "Yes (1.5 units)" : "No"} tone={task.eclo ? "text-amber-300" : ""} />
              <Field label="Activity span" value={`Wk ${task.activity_first_week} → ${task.activity_last_week}`} />
              <Field
                label="Simulated finish"
                value={fmtDate(task.simulated_finish_date)}
                tone={delayTone(task.days_delayed)}
              />
            </div>
          </section>

          {/* Occupancy */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
              <Layers className="h-3 w-3" /> Possession occupancy this week
            </h3>
            <div className="rounded-lg ring-1 ring-slate-800 divide-y divide-slate-800/70 overflow-hidden">
              {(task.occupancy?.length ? task.occupancy : [{ location_id: task.location_id, co_share_group: task.co_share_group }]).map((o) => (
                <div key={o.location_id} className="flex items-center justify-between px-3 py-1.5 bg-slate-950/40">
                  <span className="font-mono text-[11px] text-sky-300 truncate">{o.location_id}</span>
                  <span className="text-[10px] text-slate-400 shrink-0 ml-3">
                    slot <span className="font-mono text-slate-200">{o.co_share_group}</span>
                  </span>
                </div>
              ))}
            </div>
            {task.buffer_zone?.length > 0 && (
              <p className="mt-1.5 text-[10px] text-slate-500">
                Exclusion ring: {overlay.buffer.size} location{overlay.buffer.size === 1 ? "" : "s"} closed around this possession.
              </p>
            )}
            <div className="mt-3 rounded-lg bg-slate-950/40 ring-1 ring-slate-800 p-3">
              <TrackMap network={network} occupied={overlay.occupied} buffer={overlay.buffer} caption={`Week ${task.week} · ${task.location_id}`} />
            </div>
          </section>

          {/* 08_ACTIVITY_DETAILS */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
              Activity details <span className="text-slate-600 normal-case">· 08_ACTIVITY_DETAILS.csv</span>
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-lg bg-slate-950/40 ring-1 ring-slate-800 p-3">
              <Field label="Description" value={task.activity_description} />
              <Field label="Start location" value={task.start_location_id} mono />
              <Field label="End location" value={task.end_location_id} mono />
              <Field label="Total accesses" value={task.total_accesses} />
              <Field label="Planned start" value={fmtDate(task.planned_start_date)} />
              <Field label="Activity priority" value={`P${task.activity_priority}`} />
              <Field
                label="Predecessor"
                value={task.predecessor_activity_id ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[12px]">
                    <Link2 className="h-3 w-3 text-slate-500" />{task.predecessor_activity_id}
                  </span>
                ) : "None"}
              />
              <Field label="Co-share group" value={task.co_share_group} mono />
              <Field label="Activity type" value={task.activity_type} />
            </div>
          </section>

          {/* 07_PROJECT_DETAILS */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
              Contract context <span className="text-slate-600 normal-case">· 07_PROJECT_DETAILS.csv</span>
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-lg bg-slate-950/40 ring-1 ring-slate-800 p-3">
              <Field label="Contract description" value={task.contract_description} />
              <Field label="Award date" value={fmtDate(task.contract_award_date)} />
              <Field label="Activity type" value={task.activity_type} />
              <Field label="Nature of activity" value={task.nature_of_activity} />
              <Field label="Contract priority" value={`P${task.contract_priority}`} />
              <Field label="Contract completion" value={fmtDate(task.contract_completion_date)} />
              <Field label="Planned completion" value={fmtDate(task.planned_completion_date)} />
              <Field label="Workfronts" value={task.number_of_workfronts} />
              <Field label="Access type" value={task.access_type} />
              <Field label="Max access / week" value={task.number_of_maximum_access_per_week} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dashboard shell                                                    *
 * ------------------------------------------------------------------ */

export default function App() {
  const [user, setUser] = useState(null);
  const [schemas, setSchemas] = useState(FALLBACK_HEADERS);
  const [optionalSchemas, setOptionalSchemas] = useState(FALLBACK_OPTIONAL_HEADERS);
  const [apiOnline, setApiOnline] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Loading schedule…");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState("dashboard"); // "dashboard" | "editor"
  // uploads + scenario + weather toggle: kept across editor visits and persisted in localStorage
  const [editorDraft, setEditorDraft] = useState(() => loadDraft());
  const [activeWeek, setActiveWeek] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState("list");
  const [month, setMonth] = useState("");
  const [scheduleModal, setScheduleModal] = useState(null);
  const [mapDraft, setMapDraft] = useState(null);
  const [day, setDay] = useState(null);

  const weekRefs = useRef({});
  const scrollerRef = useRef(null);

  useEffect(() => { if (editorDraft) saveDraft(editorDraft); }, [editorDraft]);

  /* ---- boot ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/schemas`);
        if (!res.ok) throw new Error();
        const body = await res.json();
        if (!cancelled) {
          setSchemas(body.instance || FALLBACK_HEADERS);
          // a backend that predates the fleet registry simply reports none
          setOptionalSchemas(body.optional ?? {});
          setApiOnline(true);
        }
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Make `body` the schedule the dashboard renders and reset every view-level selection. */
  const adoptSchedule = useCallback((body) => {
    weekRefs.current = {};
    setData(body);
    setFilters(EMPTY_FILTERS);
    setMonth(body.tasks?.[0]?.date.slice(0, 7) || body.horizon.start.slice(0, 7));
    setScheduleModal(null);
    setDay(null);
    setSelected(null);
    setActiveWeek(null);
    scrollerRef.current?.scrollTo({ top: 0 });
  }, []);

  /** The active (implemented) schedule if one exists on the server, else the bundled Scenario A baseline. */
  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setLoadingLabel("Loading...");
    setError("");
    try {
      let res = await fetch(`${API_BASE}/api/schedule/active`);
      if (res.status === 204) res = await fetch(`${API_BASE}/api/schedule?scenario=A`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      adoptSchedule(await res.json());
      setApiOnline(true);
    } catch (e) {
      setError(
        `Could not reach the scheduler API at ${API_LABEL}. Start it with "uvicorn main:app --port 8000" in the backend folder.`
      );
      setApiOnline(false);
    } finally {
      setLoading(false);
    }
  }, [adoptSchedule]);

  useEffect(() => { if (user) loadSchedule(); }, [user, loadSchedule]);

  /* ---- editor: promote a previewed run to the active schedule and return to the dashboard ---- */
  const implementSchedule = useCallback(async (preview) => {
    const res = await fetch(`${API_BASE}/api/schedule/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: preview.run_id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.detail;
      throw new Error(typeof detail === "string" ? detail : detail?.message || `Could not activate schedule (${res.status})`);
    }
    adoptSchedule(body);
    setError("");
    setPage("dashboard");
  }, [adoptSchedule]);

  /* ---- RBAC filtering ---- */
  const tasks = useMemo(() => {
    if (!data?.tasks) return [];
    const scope = user?.contracts;
    const rows = scope ? data.tasks.filter((t) => scope.includes(t.contract_number)) : data.tasks;
    return [...rows].sort((a, b) => a.week - b.week || a.date.localeCompare(b.date) || a.activity_id.localeCompare(b.activity_id));
  }, [data, user]);

  const visibleTasks = useMemo(
    () => tasks.filter((task) => matches(task, filters.query, filters.priority, filters.location)),
    [tasks, filters],
  );

  const applyFilters = (next) => {
    setFilters(next);
    setScheduleModal(null);
    setActiveWeek(null);
    weekRefs.current = {};
    const first = tasks.find((task) => matches(task, next.query, next.priority, next.location));
    if (first) setMonth(first.date.slice(0, 7));
    scrollerRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
          && user && data && !loading && !selected && page === "dashboard" && !day && !scheduleModal) {
        event.preventDefault();
        setScheduleModal("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user, data, loading, selected, page, day, scheduleModal]);

  const jumpToWeek = useCallback((week) => {
    setActiveWeek(week);
    const task = visibleTasks.find((row) => row.week === week);
    if (task) setMonth(task.date.slice(0, 7));
    const el = weekRefs.current[week];
    if (el && scrollerRef.current) {
      const container = scrollerRef.current;
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8;
      container.scrollTo({ top, behavior: "smooth" });
    }
  }, [visibleTasks]);

  if (!user) return <Login onLogin={setUser} apiOnline={apiOnline} />;

  const isAdmin = user.role === "admin";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-20">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-30 bg-slate-950/95 backdrop-blur border-b border-slate-800">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30 grid place-items-center shrink-0">
            <TrainFront className="h-5 w-5 text-sky-300" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight leading-tight">Track Access Scheduler</h1>
            <p className="text-[11px] text-slate-500 truncate">
              {data ? `${data.scenario_label} · horizon from ${fmtShort(data.horizon?.start)} · ${data.horizon?.weeks} weeks${data.weather_enabled ? " · weather-aware" : ""}` : "Line Alpha · Line Beta"}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {data && (
              <span
                className={`hidden sm:inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] ring-1 ${
                  data.feasible
                    ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
                    : "bg-rose-500/10 text-rose-300 ring-rose-500/30"
                }`}
              >
                {data.feasible ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                {data.feasible ? "Feasible" : `${data.hard_violations.length} hard violation${data.hard_violations.length === 1 ? "" : "s"}`}
              </span>
            )}
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] ring-1 ${
              isAdmin ? "bg-violet-500/10 text-violet-300 ring-violet-500/30" : "bg-sky-500/10 text-sky-300 ring-sky-500/30"
            }`}>
              {isAdmin ? <Shield className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
              {user.username} · {isAdmin ? "Admin" : "Engineer"}
            </span>
            <button
              onClick={() => {
                setUser(null); setData(null); setSelected(null); setScheduleModal(null);
                setDay(null); setFilters(EMPTY_FILTERS); setView("list"); setActiveWeek(null);
                setPage("dashboard"); setMapDraft(null); // editorDraft is kept: uploads survive logout
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-slate-100 hover:bg-slate-800 ring-1 ring-slate-800"
            >
              <LogOut className="h-3 w-3" /> Logout
            </button>
          </div>
        </div>

        {/* ---------- sticky mini timeline ---------- */}
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 pb-2">
          <div className="rounded-xl bg-slate-900/60 ring-1 ring-slate-800 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <CalendarDays className="h-3 w-3 text-slate-500" />
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Possession timeline</span>
              <span className="text-[10px] text-slate-600">· click a week to jump</span>
              <div className="ml-auto flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-400/80" /> on target</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-400/80" /> ECLO</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-400/80" /> overrun</span>
                {data?.weather?.days?.length > 0 && (
                  <>
                    <span className="text-slate-700">|</span>
                    {Object.entries(WEATHER_GLYPHS).map(([key, { icon: Icon, tone, label }]) => (
                      <span key={key} className="flex items-center gap-1"><Icon className={`h-2.5 w-2.5 ${tone}`} /> {label.split(" · ")[0]}</span>
                    ))}
                    <span className="text-slate-600" title={data.weather.source}>
                      Open-Meteo{data.weather.analogue_year ? ` · analogue ${data.weather.analogue_year}` : ""}{data.weather_enabled ? " · weather-aware" : ""}
                    </span>
                  </>
                )}
              </div>
            </div>
            <TimelineStrip tasks={visibleTasks} horizon={data?.horizon} weather={data?.weather} activeWeek={activeWeek} onPickWeek={jumpToWeek} />
          </div>
        </div>
      </header>

      {/* ---------- body ---------- */}
      <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-5 space-y-5">
        {error && (
          <div className="rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-sm text-rose-200 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">{error}</div>
            <button onClick={loadSchedule} className="text-xs underline hover:no-underline">Retry</button>
          </div>
        )}

        {/* violations */}
        {data && !data.feasible && (
          <div className="rounded-xl bg-rose-500/5 ring-1 ring-rose-500/25 px-4 py-3">
            <div className="text-xs font-medium text-rose-200 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" /> Hard violations reported by the solver
            </div>
            <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
              {data.hard_violations.slice(0, 20).map((v, i) => (
                <li key={i} className="text-[11px] text-rose-200/80">
                  <span className="font-mono text-rose-300">{v.rule}</span> — {v.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* task cards */}
        <section>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h2 className="text-sm font-medium text-slate-200">Scheduled possessions</h2>
            <span className="text-[11px] text-slate-500">
              {visibleTasks.length} of {tasks.length} access nights
              {user.contracts ? ` · scoped to ${user.contracts.join(", ")}` : " · all contracts"}
            </span>
          </div>

          <ScheduleToolbar tasks={tasks} filters={filters} onApply={applyFilters}
            view={view} onView={setView} disabled={!data || loading}
            onSearch={() => setScheduleModal("search")}
            onKda={() => setScheduleModal("kda")}
            onMap={() => { setMapDraft(null); setScheduleModal("map"); }} />

          {visibleTasks.length === 0 && !loading ? (
            <div className="rounded-xl ring-1 ring-slate-800 bg-slate-900/40 px-4 py-10 text-center text-sm text-slate-500">
              {tasks.length ? "No possessions match these filters." : "No scheduled possessions in scope."}
              {Object.values(filters).some(Boolean) && <button onClick={() => applyFilters(EMPTY_FILTERS)} className="block mx-auto mt-3 text-xs text-sky-300">Clear filters and show all</button>}
            </div>
          ) : view === "month" && month ? (
            <MonthlyView tasks={visibleTasks} month={month} setMonth={setMonth} onOpenDay={setDay} onOpen={setSelected} />
          ) : (
            <div ref={scrollerRef} role="region" aria-label="Scheduled possessions" tabIndex={0} className="relative max-h-[60vh] overflow-y-auto overflow-x-hidden flex flex-col gap-3 p-2 scrollbar-thin">
              {visibleTasks.map((task, index) => (
                <TaskCard key={task.key} task={task} onOpen={setSelected} registerRef={(week, element) => {
                  if (index === 0 || visibleTasks[index - 1].week !== week) {
                    if (element) weekRefs.current[week] = element;
                    else delete weekRefs.current[week];
                  }
                }} />
              ))}
            </div>
          )}

        </section>
      </main>

      {/* ---------- admin floating action ---------- */}
      {isAdmin && (
        <button
          onClick={() => setPage("editor")}
          className="fixed bottom-6 right-6 z-30 inline-flex items-center gap-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-medium text-sm pl-4 pr-5 py-3 shadow-lg shadow-emerald-500/20 transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Reschedule
        </button>
      )}

      {scheduleModal === "search" && <SearchDialog tasks={tasks} {...filters}
        onApply={applyFilters} onClose={() => setScheduleModal(null)}
        onMap={(draft) => { setMapDraft(draft); setScheduleModal("map"); }} />}
      {scheduleModal === "map" && <LocationMap network={data?.network} tasks={tasks} week={activeWeek}
        location={mapDraft?.location ?? filters.location} onClose={() => setScheduleModal(null)}
        onSelect={(location) => { applyFilters({ ...(mapDraft || filters), location }); setMapDraft(null); }} />}
      {scheduleModal === "kda" && data && <KdaDialog data={data} onClose={() => setScheduleModal(null)}
        downloads={isAdmin ? OUTPUT_FILES.map((name) => ({ name, href: `${API_BASE}/api/download/${data.scenario}/${name}?run_id=${data.run_id}` })) : []} />}
      {day && <Dialog title={`Possessions · ${fmtDate(day.date)}`}
        subtitle={`${day.tasks.length} access nights · week-start date`} icon={CalendarDays} onClose={() => setDay(null)}>
        <div className="p-4 space-y-3">{day.tasks.map((task) => (
          <TaskCard key={task.key} task={task} registerRef={() => {}}
            onOpen={(row) => { setDay(null); setSelected(row); }} />
        ))}</div>
      </Dialog>}
      {selected && <ActivityModal task={selected} network={data?.network} onClose={() => setSelected(null)} />}
      {page === "editor" && isAdmin && (
        <EditorView
          schemas={schemas}
          optionalSchemas={optionalSchemas}
          apiBase={API_BASE}
          draft={editorDraft}
          onDraftChange={setEditorDraft}
          onBack={() => setPage("dashboard")}
          onImplement={implementSchedule}
        />
      )}

      {/* ---------- loading overlay ---------- */}
      {loading && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm grid place-items-center">
          <div className="rounded-2xl bg-slate-900 ring-1 ring-slate-800 px-6 py-5 text-center shadow-2xl">
            <RefreshCw className="h-6 w-6 text-sky-300 animate-spin mx-auto" />
            <p className="mt-3 text-sm text-slate-200">{loadingLabel}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Packing co-share slots and checking buffers…</p>
          </div>
        </div>
      )}
    </div>
  );
}
