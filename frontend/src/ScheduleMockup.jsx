import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Download, Gauge, Layers, List, LogOut, Map, MapPin, Moon, RefreshCw, Search, Shield, SlidersHorizontal, TrainFront, X } from "lucide-react";
import { ActivityModal, Metric, SCENARIOS, TaskCard, TimelineStrip } from "./App.jsx";
import snapshots from "./mockup-data.json";

// Rehydrate repeated activity details only when the isolated preview is loaded.
const fixtures = Object.fromEntries(Object.entries(snapshots).map(([id, data]) => [id, {
  ...data, tasks: data.tasks.map((task) => ({ ...data.task_templates[task.activity_id], ...task })),
}]));

function exportSnapshot(data, name) {
  const headers = name === "SCHEDULE_ACCESS" ? ["activity_id", "access_seq", "week", "eclo", "access_night"]
    : name === "SCHEDULE_OCCUPANCY" ? ["activity_id", "week", "location_id", "co_share_group"]
    : ["scenario", "contract_number", "simulated_completion_date", "overrun_days"];
  const rows = name === "RESULTS" ? data.results : name === "SCHEDULE_ACCESS" ? data.tasks
    : data.tasks.flatMap((task) => task.occupancy.map((slot) => ({ activity_id: task.activity_id, week: task.week, ...slot })));
  const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => JSON.stringify(String(row[key] ?? ""))).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `MOCKUP_${data.scenario}_${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400";
const input = "w-full rounded-lg bg-slate-950 ring-1 ring-slate-700 focus:ring-sky-500 outline-none px-3 py-2.5 text-sm text-slate-200";
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const taskLocations = (t) => t.locations?.length ? t.locations : [t.location_id];
const matches = (t, query, priority, location) => (!query || t.contract_number.toLowerCase().includes(query.trim().toLowerCase())) && (!priority || t.contract_priority === Number(priority)) && (!location || taskLocations(t).some((l) => l.includes(location)));

function Dialog({ title, subtitle, icon: Icon = Search, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    dialog.querySelector("input")?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="mockup-dialog-title" className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-4xl" : "max-w-2xl"} max-h-[88vh] overflow-y-auto rounded-2xl bg-slate-900 p-0 text-slate-100 ring-1 ring-slate-700 shadow-2xl backdrop:bg-slate-950/80 backdrop:backdrop-blur-sm`}>
    <div className="flex items-start gap-3 border-b border-slate-800 px-5 py-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30"><Icon className="h-4 w-4 text-sky-300" /></div>
      <div className="flex-1"><h2 id="mockup-dialog-title" className="text-base font-medium">{title}</h2><p className="mt-1 text-xs text-slate-400">{subtitle}</p></div>
      <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
    </div>
    {children}
  </dialog>;
}

function SearchDialog({ tasks, query, priority, location, onApply, onClose, onMap }) {
  const [draft, setDraft] = useState({ query, priority, location });
  const count = tasks.filter((t) => matches(t, draft.query, draft.priority, draft.location)).length;
  const locations = [...new Set(tasks.flatMap(taskLocations))].sort();
  return <Dialog title="Search schedule" subtitle="Find a project and narrow its scheduled possessions." onClose={onClose}>
    <form onSubmit={(e) => { e.preventDefault(); onApply({ ...draft, query: draft.query.trim() }); }} className="p-5 space-y-5">
      <div><label htmlFor="project-code" className="mb-2 block text-xs text-slate-300">Project code</label><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-500" /><input autoFocus id="project-code" value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} placeholder="Search by project code, e.g. C001" className={`${input} pl-10`} /></div><p className="mt-2 text-[11px] text-slate-500">Project codes use the contract number in this schedule.</p></div>
      <div className="grid sm:grid-cols-2 gap-4"><div><label htmlFor="search-priority" className="mb-2 block text-xs text-slate-300">Filter by priority</label><select id="search-priority" className={input} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}><option value="">All priorities</option><option value="1">P1 · High</option><option value="2">P2 · Medium</option><option value="3">P3 · Low</option></select></div>
      <div><label htmlFor="search-location" className="mb-2 block text-xs text-slate-300">Filter by location</label><select id="search-location" className={input} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })}><option value="">All locations</option><option value="ALP">Line Alpha · all locations</option><option value="BET">Line Beta · all locations</option>{location && !locations.includes(location) && !["ALP", "BET"].includes(location) && <option value={location}>{location}</option>}{locations.map((l) => <option key={l}>{l}</option>)}</select></div></div>
      <button type="button" onClick={() => onMap(draft)} className={button}><Map className="h-4 w-4 text-sky-300" /> Choose location on map</button>
      <div className="flex items-center gap-3 border-t border-slate-800 pt-4"><p className="mr-auto text-xs text-slate-400" aria-live="polite">{count} matching access nights</p><button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setDraft({ query: "", priority: "", location: "" })}>Reset</button><button type="submit" className={`${button} bg-sky-500 !text-slate-950 !ring-sky-500 hover:bg-sky-400 font-medium`}><Search className="h-4 w-4" /> Show results</button></div>
    </form>
  </Dialog>;
}

function KdaDialog({ data, onClose }) {
  const scores = data.soft_scores;
  const scenario = SCENARIOS.find((s) => s.id === data.scenario);
  const rows = [
    ["Priority-weighted overrun", data.scenario === "B" ? "No overrun allowed · hard constraint" : "Contract tier × activity multiplier × overrun days", scores.priority_weighted_score, data.scenario === "B" ? "—" : scores.priority_weighted_score],
    ["Excess access nights", data.scenario === "A" ? "No excess allowed · hard constraint" : data.scenario === "C" ? "7 points / night · max +1 per location-week" : "7 points per excess night", scores.excess_access_nights_total, data.scenario === "A" ? "—" : scores.excess_access_nights_total * 7],
    ["ECLO nights", data.scenario === "A" ? "ECLO forbidden · hard constraint" : data.scenario === "C" ? "5 points / night · one ≤2-week window per line" : "5 points per ECLO night", scores.eclo_nights_total, data.scenario === "A" ? "—" : scores.eclo_nights_total * 5],
  ];
  return <Dialog title="Schedule KDA" subtitle={`${scenario.name} · ${scenario.label}`} icon={Gauge} onClose={onClose} wide>
    <div className="p-5 space-y-5">
      <div className="rounded-xl bg-sky-500/5 ring-1 ring-sky-500/20 px-4 py-3 flex items-center gap-3"><Shield className="h-5 w-5 text-emerald-300" /><div className="flex-1"><p className="text-sm text-emerald-300">{data.feasible ? "All hard constraints satisfied" : "Hard constraints require review"}</p><p className="text-xs text-slate-400 mt-1">Full schedule · filters do not change this assessment</p></div><span className="text-xs text-slate-400">{data.hard_violations.length} violations</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2"><Metric icon={Gauge} label="Objective score" value={scores.objective_score} tone="text-sky-300" description="Lower is better" /><Metric icon={ClipboardList} label="Activities scheduled" value={`${data.counts.activities_scheduled} / ${data.counts.activities_total}`} /><Metric icon={CalendarDays} label="Overrun days" value={scores.overrun_days_total} description={`Across ${scores.contracts_overrunning} contracts`} /><Metric icon={Moon} label="ECLO nights" value={scores.eclo_nights_total} /></div>
      <div><h3 className="text-xs text-slate-300 mb-3">Scenario rubric breakdown</h3><div className="overflow-x-auto rounded-xl ring-1 ring-slate-800"><table className="w-full text-left text-xs"><thead className="bg-slate-950/70 text-slate-500"><tr><th className="px-4 py-3 font-normal">Measure / rule</th><th className="px-4 py-3 font-normal text-right">Value</th><th className="px-4 py-3 font-normal text-right">Contribution</th></tr></thead><tbody>{rows.map(([name, rule, value, contribution]) => <tr key={name} className="border-t border-slate-800"><td className="px-4 py-4 text-slate-200">{name}<div className="text-[11px] text-slate-500 mt-1">{rule}</div></td><td className="px-4 py-4 text-right tabular-nums">{value}</td><td className="px-4 py-4 text-right tabular-nums text-sky-300">{contribution}</td></tr>)}</tbody></table></div></div>
      <p className="text-[11px] text-slate-500">Rubric §2.5 · Contract weights P1 / P2 / P3: 100 / 10 / 1. Activity multipliers: 1.3 / 1.2 / 1.0. Objective applies to feasible schedules only.</p>
    </div>
  </Dialog>;
}

function LocationMap({ location, onSelect, onClose }) {
  return <Dialog title="Choose a location" subtitle="Select a station or an entire line to filter the schedule." icon={Map} onClose={onClose} wide>
    <div className="p-5 space-y-7">
      <p className="text-[11px] text-slate-500">Network schematic · not to scale · includes possessions occupying the selected station or its adjacent sectors</p>
      {[["ALP", "Line Alpha", ["S01", "S02", "S03", "S04", "H01", "H02", "S05", "S06", "S07", "S08"]], ["BET", "Line Beta", ["S11", "S12", "S13", "S14", "H01", "H02", "S15", "S16", "S17", "S18"]]].map(([code, name, stations]) => <div key={code}><button className={`${button} mb-5`} onClick={() => onSelect(code)}>{name}<ChevronRight className="h-3 w-3" /></button><div className="overflow-x-auto pb-3"><div className="relative flex justify-between min-w-[560px] px-3"><div className={`absolute top-2 left-5 right-5 h-1 ${code === "ALP" ? "bg-sky-500/50" : "bg-violet-500/50"}`} />{stations.map((station) => <button key={station} onClick={() => onSelect(station)} aria-label={`Filter ${name}, station ${station}`} className="relative flex flex-col items-center gap-3 group"><span className={`h-5 w-5 rounded-full border-4 ${location === station ? "bg-white border-sky-400" : "bg-slate-900 border-slate-500 group-hover:border-sky-300"}`} /><span className="text-[11px] font-mono text-slate-300">{station}</span>{station.startsWith("H") && <span className="text-[9px] text-slate-500">Interchange</span>}</button>)}</div></div></div>)}
      <button onClick={() => onSelect("")} className={button}>Show all locations</button>
    </div>
  </Dialog>;
}

function MonthlyView({ tasks, month, setMonth, onOpenDay, onOpen }) {
  const start = new Date(`${month}-01T00:00:00`);
  const offset = (start.getDay() + 6) % 7;
  const last = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((offset + last) / 7) * 7;
  const changeMonth = (by) => setMonth(isoDate(new Date(start.getFullYear(), start.getMonth() + by, 1)).slice(0, 7));
  return <div className="rounded-xl ring-1 ring-slate-800 bg-slate-900/40 overflow-hidden">
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800"><h3 className="text-sm font-medium mr-auto">{start.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h3><span className="text-[11px] text-slate-500">Week-start dates · open a day for all possessions</span><button className={button} aria-label="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft className="h-3 w-3" /></button><button className={button} aria-label="Next month" onClick={() => changeMonth(1)}><ChevronRight className="h-3 w-3" /></button></div>
    <div className="overflow-x-auto"><div className="min-w-[700px]"><div className="grid grid-cols-7 bg-slate-950/40">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500">{d}</div>)}</div><div className="grid grid-cols-7">{Array.from({ length: cells }, (_, i) => {
      const day = new Date(start.getFullYear(), start.getMonth(), i - offset + 1);
      const date = isoDate(day);
      const entries = tasks.filter((t) => t.date === date);
      const current = day.getMonth() === start.getMonth();
      return <div key={date} className={`min-h-[135px] border-t border-r border-slate-800/70 p-2 ${current ? "" : "bg-slate-950/40"}`}><div className={`mb-2 text-[11px] ${current ? "text-slate-300" : "text-slate-600"}`}>{day.getDate()}{entries.length > 0 && <span className="float-right text-slate-500">{entries.length} {entries.length === 1 ? "night" : "nights"}</span>}</div><div className="space-y-1">{entries.slice(0, 2).map((t) => <button key={t.key} onClick={() => onOpen(t)} className={`w-full text-left rounded px-2 py-1.5 text-[10px] ring-1 ${t.days_delayed ? "bg-rose-500/10 text-rose-300 ring-rose-500/20" : t.eclo ? "bg-amber-500/10 text-amber-300 ring-amber-500/20" : "bg-sky-500/10 text-sky-300 ring-sky-500/20"}`}><span className="block font-mono">{t.contract_number}:{t.activity_id}</span><span className="block truncate opacity-70">{t.location_id}</span></button>)}{entries.length > 2 && <button onClick={() => onOpenDay({ date, tasks: entries })} className="text-[10px] text-slate-400 hover:text-sky-300 px-1">+{entries.length - 2} more possessions</button>}</div></div>;
    })}</div></div></div>
  </div>;
}

export default function ScheduleMockup() {
  const [scenario, setScenario] = useState("A");
  const [filters, setFilters] = useState({ query: "", priority: "", location: "" });
  const [view, setView] = useState("list");
  const [month, setMonth] = useState(fixtures.A.horizon.start.slice(0, 7));
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [day, setDay] = useState(null);
  const [activeWeek, setActiveWeek] = useState(null);
  const [mapDraft, setMapDraft] = useState(null);
  const refs = useRef({});
  const data = fixtures[scenario];
  const tasks = useMemo(() => data.tasks.filter((t) => matches(t, filters.query, filters.priority, filters.location)), [data, filters]);
  const locations = [...new Set(data.tasks.flatMap(taskLocations))].sort();
  const filterCount = Object.values(filters).filter(Boolean).length;
  const stats = { activities: new Set(data.tasks.map((t) => t.activity_id)).size, contracts: new Set(data.tasks.map((t) => t.contract_number)).size, delayed: data.tasks.filter((t) => t.days_delayed > 0).length };
  const apply = (next) => { setFilters(next); setModal(null); setActiveWeek(null); const first = data.tasks.find((t) => matches(t, next.query, next.priority, next.location)); if (first) setMonth(first.date.slice(0, 7)); };
  const jump = (week) => { setActiveWeek(week); const task = tasks.find((t) => t.week === week); if (task) setMonth(task.date.slice(0, 7)); refs.current[week]?.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  useEffect(() => { const handler = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); if (!selected) setModal("search"); } }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [selected]);
  return <div className="min-h-screen bg-slate-950 text-slate-100 pb-20">
    <header className="sticky top-0 z-30 bg-slate-950/95 backdrop-blur border-b border-slate-800"><div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center gap-3"><div className="h-9 w-9 rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30 grid place-items-center shrink-0"><TrainFront className="h-5 w-5 text-sky-300" /></div><div className="min-w-0"><h1 className="text-sm font-semibold tracking-tight">Track Access Scheduler</h1><p className="text-[11px] text-slate-500 truncate">{data.scenario_label} · horizon from 04 Jan · {data.horizon.weeks} weeks</p></div><div className="ml-auto flex items-center gap-2"><span className="hidden sm:inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] ring-1 bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"><CheckCircle2 className="h-3 w-3" /> Feasible</span><span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] ring-1 bg-violet-500/10 text-violet-300 ring-violet-500/30"><Shield className="h-3 w-3" /> admin · Admin</span><a href="/" className={`${button} !px-2.5 !py-1.5 !text-[11px]`}><LogOut className="h-3 w-3" /><span className="hidden sm:inline">Exit mockup</span></a></div></div>
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 pb-2"><div className="rounded-xl bg-slate-900/60 ring-1 ring-slate-800 px-3 py-2"><div className="flex flex-wrap items-center gap-2 mb-1"><CalendarDays className="h-3 w-3 text-slate-500" /><span className="text-[10px] uppercase tracking-wider text-slate-500">Possession timeline</span><span className="text-[10px] text-slate-600">· click a week to jump</span><div className="ml-auto flex items-center gap-3 text-[10px] text-slate-500">{[["on target", "bg-sky-400/80"], ["ECLO", "bg-amber-400/80"], ["overrun", "bg-rose-400/80"]].map(([label, tone]) => <span key={label} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${tone}`} />{label}</span>)}</div></div><TimelineStrip tasks={tasks} horizon={data.horizon} activeWeek={activeWeek} onPickWeek={jump} /></div></div></header>
    <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-5 space-y-5">
      <div className="flex flex-wrap items-center gap-2">{SCENARIOS.map((s) => <button key={s.id} onClick={() => { setScenario(s.id); setActiveWeek(null); }} aria-pressed={scenario === s.id} title={s.hint} className={`${button} ${scenario === s.id ? "!bg-sky-500/15 !text-sky-300 !ring-sky-500" : ""}`}>{s.name}</button>)}<span className="text-xs text-slate-500 ml-1">Using bundled reference CSVs</span><span className="ml-auto rounded-full bg-slate-900 ring-1 ring-slate-800 px-3 py-1 text-[10px] tracking-wide text-slate-400">INTERACTIVE MOCKUP</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2"><Metric icon={Moon} label="Access nights" value={data.tasks.length} /><Metric icon={ClipboardList} label="Activities" value={stats.activities} /><Metric icon={Layers} label="Contracts" value={stats.contracts} /><Metric icon={Gauge} label="Overrunning accesses" value={stats.delayed} tone="text-rose-300" /><Metric icon={Moon} label="ECLO nights" value={data.soft_scores.eclo_nights_total} /><Metric icon={Gauge} label="Objective" value={data.soft_scores.objective_score} tone="text-emerald-300" /></div>
      <section className="space-y-3"><div className="flex flex-wrap justify-end gap-2">{["SCHEDULE_ACCESS", "SCHEDULE_OCCUPANCY", "RESULTS"].map((name) => <button key={name} onClick={() => exportSnapshot(data, name)} title="Download this preview snapshot" className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-sky-300 ring-1 ring-slate-800 rounded-lg px-2 py-1"><Download className="h-3 w-3" />{name}</button>)}</div><div className="flex flex-wrap items-center gap-3"><div className="mr-auto"><h2 className="text-sm font-medium text-slate-200">Scheduled possessions</h2><p className="text-[11px] text-slate-500 mt-1" aria-live="polite">{tasks.length} of {data.tasks.length} access nights · {filterCount ? "filtered schedule" : "all contracts"}</p></div><button onClick={() => setModal("kda")} className={`${button} !ring-sky-500/30 !text-sky-300 !bg-sky-500/5`}><Gauge className="h-4 w-4" /> Schedule KDA</button><button onClick={() => setModal("search")} className={button}><Search className="h-4 w-4" /> Search<span className="hidden sm:inline text-[10px] text-slate-500 ml-2">⌘ K</span></button><div className="inline-flex rounded-lg bg-slate-900 p-1 ring-1 ring-slate-800" role="group" aria-label="Schedule view">{[["list", List, "List"], ["month", CalendarDays, "Month"]].map(([id, Icon, label]) => <button key={id} onClick={() => setView(id)} aria-pressed={view === id} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs ${view === id ? "bg-slate-700/70 text-sky-300 shadow-sm" : "text-slate-500 hover:text-slate-200"}`}><Icon className="h-3.5 w-3.5" />{label}</button>)}</div></div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-900/60 ring-1 ring-slate-800 px-3 py-3"><span className="inline-flex items-center gap-2 text-xs text-slate-500"><SlidersHorizontal className="h-3.5 w-3.5" /> Filters</span><select aria-label="Filter by priority" className={`${input} !w-auto !py-2 !text-xs`} value={filters.priority} onChange={(e) => apply({ ...filters, priority: e.target.value })}><option value="">All priorities</option><option value="1">P1 · High priority</option><option value="2">P2 · Medium priority</option><option value="3">P3 · Low priority</option></select><div className="relative flex-1 min-w-[170px] max-w-[310px]"><MapPin className="absolute left-2.5 top-2.5 h-3 w-3 text-slate-500" /><select aria-label="Filter by location" className={`${input} !pl-8 !py-2 !text-xs`} value={filters.location} onChange={(e) => apply({ ...filters, location: e.target.value })}><option value="">All locations</option><option value="ALP">Line Alpha</option><option value="BET">Line Beta</option>{filters.location && !locations.includes(filters.location) && !["ALP", "BET"].includes(filters.location) && <option value={filters.location}>{filters.location}</option>}{locations.map((l) => <option key={l}>{l}</option>)}</select></div><button className={`${button} !ring-slate-800`} onClick={() => { setMapDraft(null); setModal("map"); }}><Map className="h-3.5 w-3.5" /> Map</button><span className="ml-auto text-[11px] text-slate-500">Filters apply to both views</span></div>
      {filterCount > 0 && <div className="flex flex-wrap items-center gap-2">{Object.entries(filters).filter(([, value]) => value).map(([key, value]) => <button key={key} aria-label={`Remove ${key} filter`} onClick={() => apply({ ...filters, [key]: "" })} className="inline-flex items-center gap-2 rounded-md bg-sky-500/10 ring-1 ring-sky-500/20 px-2.5 py-1 text-[11px] text-sky-300">{key === "priority" ? `Priority P${value}` : key === "query" ? `Project: ${value}` : value}<X className="h-3 w-3" /></button>)}<button onClick={() => apply({ query: "", priority: "", location: "" })} className="text-[11px] text-slate-400 hover:text-white ml-1">Clear all</button></div>}
      {tasks.length === 0 ? <div className="rounded-xl ring-1 ring-slate-800 bg-slate-900/40 py-16 text-center"><Search className="h-6 w-6 text-slate-600 mx-auto mb-3" /><p className="text-sm text-slate-300">No possessions match these filters</p><button onClick={() => apply({ query: "", priority: "", location: "" })} className="text-xs text-sky-300 mt-3">Clear filters and show all</button></div> : view === "list" ? <div key={`${scenario}-${JSON.stringify(filters)}`} role="region" aria-label="Scheduled possessions" tabIndex={0} className="max-h-[57vh] overflow-y-auto flex flex-col gap-3 p-2 scrollbar-thin">{tasks.map((t, i) => <TaskCard key={t.key} task={t} onOpen={setSelected} registerRef={(week, el) => { if (el && (i === 0 || tasks[i - 1].week !== week)) refs.current[week] = el; }} />)}</div> : <MonthlyView tasks={tasks} month={month} setMonth={setMonth} onOpenDay={setDay} onOpen={setSelected} />}
      <p className="text-[10px] text-slate-600">Preview uses a snapshot of the bundled schedule. Summary tiles and KDA always describe the full scenario.</p>
      </section>
    </main>
    <button onClick={() => setModal("reschedule")} className="fixed bottom-6 right-6 z-30 inline-flex items-center gap-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-medium text-sm pl-4 pr-5 py-3 shadow-lg shadow-emerald-500/20"><RefreshCw className="h-4 w-4" />Reschedule</button>
    {modal === "search" && <SearchDialog tasks={data.tasks} {...filters} onApply={apply} onClose={() => setModal(null)} onMap={(draft) => { setMapDraft(draft); setModal("map"); }} />}
    {modal === "kda" && <KdaDialog data={data} onClose={() => setModal(null)} />}
    {modal === "map" && <LocationMap location={filters.location} onClose={() => setModal(null)} onSelect={(location) => { apply({ ...(mapDraft || filters), location }); setMapDraft(null); }} />}
    {modal === "reschedule" && <Dialog title="Reschedule" subtitle="Interactive design preview" icon={RefreshCw} onClose={() => setModal(null)}><div className="p-5 text-sm text-slate-400">Use the live application to upload CSVs and run a new schedule. You can preview all three scenarios here.<div className="mt-5"><a href="/" className={button}>Open live application<ChevronRight className="h-4 w-4" /></a></div></div></Dialog>}
    {day && !selected && <Dialog title={`Possessions · ${day.date}`} subtitle={`${day.tasks.length} access nights · week-start date`} icon={CalendarDays} onClose={() => setDay(null)}><div className="p-4 space-y-3">{day.tasks.map((t) => <TaskCard key={t.key} task={t} onOpen={(task) => { setDay(null); setSelected(task); }} registerRef={() => {}} />)}</div></Dialog>}
    {selected && <ActivityModal task={selected} onClose={() => setSelected(null)} />}
  </div>;
}
