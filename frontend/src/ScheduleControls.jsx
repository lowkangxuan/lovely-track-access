import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Gauge, List, Map as MapIcon, MapPin, Moon, Search, Shield, SlidersHorizontal, X } from "lucide-react";
import Metric from "./Metric.jsx";
import { ACTIVITY_PRIORITIES, activityPriority, calendarDays, isoDate, matches, taskLocations } from "./schedule-utils.js";

const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400";
const input = "w-full rounded-lg bg-slate-950 ring-1 ring-slate-700 focus:ring-sky-500 outline-none px-3 py-2.5 text-sm text-slate-200";

export function Dialog({ title, subtitle, icon: Icon = Search, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    dialog.querySelector("input")?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="schedule-dialog-title" className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-4xl" : "max-w-2xl"} max-h-[88vh] overflow-y-auto rounded-2xl bg-slate-900 p-0 text-slate-100 ring-1 ring-slate-700 shadow-2xl backdrop:bg-slate-950/80 backdrop:backdrop-blur-sm`}>
    <div className="flex items-start gap-3 border-b border-slate-800 px-5 py-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15 ring-1 ring-sky-400/30"><Icon className="h-4 w-4 text-sky-300" /></div>
      <div className="flex-1"><h2 id="schedule-dialog-title" className="text-base font-medium">{title}</h2><p className="mt-1 text-xs text-slate-400">{subtitle}</p></div>
      <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
    </div>
    {children}
  </dialog>;
}

export function SearchDialog({ tasks, query, priority, location, onApply, onClose, onMap }) {
  const [draft, setDraft] = useState({ query, priority, location });
  const count = tasks.filter((t) => matches(t, draft.query, draft.priority, draft.location)).length;
  const locations = [...new Set(tasks.flatMap(taskLocations))].sort();
  const lines = [...new Set(locations.map((id) => id.split(":")[1]))].sort();
  return <Dialog title="Search schedule" subtitle="Find a project and narrow its scheduled possessions." onClose={onClose}>
    <form onSubmit={(e) => { e.preventDefault(); onApply({ ...draft, query: draft.query.trim() }); }} className="p-5 space-y-5">
      <div><label htmlFor="project-code" className="mb-2 block text-xs text-slate-300">Project code</label><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-500" /><input autoFocus id="project-code" value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} placeholder="Search by project code, e.g. C001" className={`${input} pl-10`} /></div><p className="mt-2 text-[11px] text-slate-500">Project codes use the contract number in this schedule.</p></div>
      <div className="grid sm:grid-cols-2 gap-4"><div><label htmlFor="search-priority" className="mb-2 block text-xs text-slate-300">Activity priority</label><select id="search-priority" className={input} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}><option value="">All activity priorities</option><option value="1">P1 · Highest</option><option value="2">P2 · Medium</option><option value="3">P3 · Lowest</option></select></div>
      <div><label htmlFor="search-location" className="mb-2 block text-xs text-slate-300">Filter by location</label><select id="search-location" className={input} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })}><option value="">All locations</option>{lines.map((line) => <option key={line} value={line}>Line {line} · all locations</option>)}{location && !locations.includes(location) && !lines.includes(location) && <option value={location}>{location}</option>}{locations.map((l) => <option key={l}>{l}</option>)}</select></div></div>
      <button type="button" onClick={() => onMap(draft)} className={button}><MapIcon className="h-4 w-4 text-sky-300" /> Choose location on map</button>
      <div className="flex items-center gap-3 border-t border-slate-800 pt-4"><p className="mr-auto text-xs text-slate-400" aria-live="polite">{count} matching access nights</p><button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setDraft({ query: "", priority: "", location: "" })}>Reset</button><button type="submit" className={`${button} bg-sky-500 !text-slate-950 !ring-sky-500 hover:bg-sky-400 font-medium`}><Search className="h-4 w-4" /> Show results</button></div>
    </form>
  </Dialog>;
}

export function KdaDialog({ data, onClose }) {
  const scores = data.soft_scores;
  const scenario = { name: `Scenario ${data.scenario}`, label: data.scenario_label };
  const rows = [
    ["Priority-weighted overrun", data.scenario === "B" ? "No overrun allowed · hard constraint" : "Contract tier × activity multiplier × overrun days", scores.priority_weighted_score, data.scenario === "B" ? "—" : scores.priority_weighted_score],
    ["Excess access nights", data.scenario === "A" ? "No excess allowed · hard constraint" : data.scenario === "C" ? "7 points / night · max +1 per location-week" : "7 points per excess night", scores.excess_access_nights_total, data.scenario === "A" ? "—" : scores.excess_access_nights_total * 7],
    ["ECLO nights", data.scenario === "A" ? "ECLO forbidden · hard constraint" : data.scenario === "C" ? "5 points / night · one ≤2-week window per line" : "5 points per ECLO night", scores.eclo_nights_total, data.scenario === "A" ? "—" : scores.eclo_nights_total * 5],
  ];
  return <Dialog title="Schedule KDA" subtitle={`${scenario.name} · ${scenario.label}`} icon={Gauge} onClose={onClose} wide>
    <div className="p-5 space-y-5">
      <div className="rounded-xl bg-sky-500/5 ring-1 ring-sky-500/20 px-4 py-3 flex items-center gap-3"><Shield className="h-5 w-5 text-slate-300" /><div className="flex-1"><p className={`text-sm ${data.feasible ? "text-emerald-300" : "text-rose-300"}`}>{data.feasible ? "All hard constraints satisfied" : "Hard constraints require review"}</p><p className="text-xs text-slate-400 mt-1">Full schedule · filters do not change this assessment</p></div><span className="text-xs text-slate-400">{data.hard_violations.length} violations</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2"><Metric icon={Gauge} label="Objective score" value={scores.objective_score ?? "—"} tone="text-sky-300" description={data.feasible ? "Lower is better" : "Infeasible schedule"} /><Metric icon={ClipboardList} label="Activities scheduled" value={`${data.counts.activities_scheduled} / ${data.counts.activities_total}`} /><Metric icon={CalendarDays} label="Overrun days" value={scores.overrun_days_total} description={`Across ${scores.contracts_overrunning} contracts`} /><Metric icon={Moon} label="ECLO nights" value={scores.eclo_nights_total} /></div>
      <div><h3 className="text-xs text-slate-300 mb-3">Scenario rubric breakdown</h3><div className="overflow-x-auto rounded-xl ring-1 ring-slate-800"><table className="w-full text-left text-xs"><thead className="bg-slate-950/70 text-slate-500"><tr><th className="px-4 py-3 font-normal">Measure / rule</th><th className="px-4 py-3 font-normal text-right">Value</th><th className="px-4 py-3 font-normal text-right">Contribution</th></tr></thead><tbody>{rows.map(([name, rule, value, contribution]) => <tr key={name} className="border-t border-slate-800"><td className="px-4 py-4 text-slate-200">{name}<div className="text-[11px] text-slate-500 mt-1">{rule}</div></td><td className="px-4 py-4 text-right tabular-nums">{value}</td><td className="px-4 py-4 text-right tabular-nums text-sky-300">{contribution}</td></tr>)}</tbody></table></div></div>
      <p className="text-[11px] text-slate-500">Rubric §2.5 · Contract weights P1 / P2 / P3: 100 / 10 / 1. Activity multipliers: 1.3 / 1.2 / 1.0. Objective applies to feasible schedules only.</p>
    </div>
  </Dialog>;
}


export function LocationMap({ network, tasks, location, onSelect, onClose }) {
  // Only offer stations occupied by the user's scoped tasks, ordered by the live network.
  const occupied = new Set(tasks.flatMap(taskLocations));
  const lines = (network?.lines ?? []).map((line) => ({
    ...line,
    stations: (network.stations ?? [])
      .filter((station) => station.line_code === line.line_code && [...occupied].some((id) => {
        const [, code, segment] = id.split(":");
        return code === line.line_code && segment?.split("_").includes(station.station_id);
      }))
      .sort((a, b) => a.seq - b.seq),
  })).filter((line) => line.stations.length);

  return (
    <Dialog title="Choose a location" subtitle="Select a station or an entire line to filter the schedule." icon={MapIcon} onClose={onClose} wide>
      <div className="p-5 space-y-7">
        <p className="text-[11px] text-slate-500">Network schematic · not to scale · stations with possessions in your scope. Station filters include adjacent sectors.</p>
        {lines.map((line, index) => (
          <div key={line.line_code}>
            <button className={`${button} mb-5`} onClick={() => onSelect(line.line_code)}>
              {line.line_name} <ChevronRight className="h-3 w-3" />
            </button>
            <div className="overflow-x-auto pb-3">
              <div className="relative flex justify-between gap-6 px-3 min-w-max">
                <div className={`absolute top-2 left-5 right-5 h-1 ${index % 2 ? "bg-violet-500/50" : "bg-sky-500/50"}`} />
                {line.stations.map((station) => (
                  <button key={station.station_id} onClick={() => onSelect(station.station_id)}
                    aria-label={`Filter ${line.line_name}, station ${station.station_id}`}
                    className="relative flex flex-col items-center gap-3 group">
                    <span className={`h-5 w-5 rounded-full border-4 ${location === station.station_id ? "bg-white border-sky-400" : "bg-slate-900 border-slate-500 group-hover:border-sky-300"}`} />
                    <span className="text-[11px] font-mono text-slate-300">{station.station_id}</span>
                    {station.is_interchange === 1 && <span className="text-[9px] text-slate-500">Interchange</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {!lines.length && <p className="text-sm text-slate-400">No network map is available for this schedule. Use the location filter to select an occupied location.</p>}
        <button onClick={() => onSelect("")} className={button}>Show all locations</button>
      </div>
    </Dialog>
  );
}

export function ScheduleToolbar({ tasks, filters, onApply, view, onView, onSearch, onMap, onKda, disabled }) {
  const locations = [...new Set(tasks.flatMap(taskLocations))].sort();
  const lines = [...new Set(locations.map((id) => id.split(":")[1]))].sort();
  const active = Object.entries(filters).filter(([, value]) => value);
  return (
    <div className="space-y-3 mb-3">
      <div className="flex flex-wrap justify-end gap-2">
        <button disabled={disabled} onClick={onKda} className={`${button} !ring-sky-500/30 !text-sky-300 !bg-sky-500/5 disabled:opacity-40`}>
          <Gauge className="h-4 w-4" /> Schedule KDA
        </button>
        <button disabled={disabled} onClick={onSearch} className={`${button} disabled:opacity-40`}>
          <Search className="h-4 w-4" /> Search <span className="hidden sm:inline text-[10px] text-slate-500 ml-2">⌘ K</span>
        </button>
        <div className="inline-flex rounded-lg bg-slate-900 p-1 ring-1 ring-slate-800" role="group" aria-label="Schedule view">
          {[["list", List, "List"], ["month", CalendarDays, "Month"]].map(([id, Icon, label]) => (
            <button key={id} disabled={disabled} onClick={() => onView(id)} aria-pressed={view === id}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs disabled:opacity-40 ${view === id ? "bg-slate-700/70 text-sky-300 shadow-sm" : "text-slate-500 hover:text-slate-200"}`}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-900/60 ring-1 ring-slate-800 px-3 py-3">
        <span className="inline-flex items-center gap-2 text-xs text-slate-500"><SlidersHorizontal className="h-3.5 w-3.5" /> Filters</span>
        <select aria-label="Filter by activity priority" className={`${input} !w-auto !py-2 !text-xs`}
          value={filters.priority} onChange={(e) => onApply({ ...filters, priority: e.target.value })}>
          <option value="">All activity priorities</option>
          {Object.entries(ACTIVITY_PRIORITIES).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <div className="relative flex-1 min-w-[170px] max-w-[310px]">
          <MapPin className="absolute left-2.5 top-2.5 h-3 w-3 text-slate-500" />
          <select aria-label="Filter by location" className={`${input} !pl-8 !py-2 !text-xs`}
            value={filters.location} onChange={(e) => onApply({ ...filters, location: e.target.value })}>
            <option value="">All locations</option>
            {lines.map((line) => <option key={line} value={line}>Line {line}</option>)}
            {filters.location && !locations.includes(filters.location) && !lines.includes(filters.location) && <option value={filters.location}>{filters.location}</option>}
            {locations.map((id) => <option key={id}>{id}</option>)}
          </select>
        </div>
        <button disabled={disabled} className={`${button} !ring-slate-800 disabled:opacity-40`} onClick={onMap}><MapIcon className="h-3.5 w-3.5" /> Map</button>
        <span className="ml-auto text-[11px] text-slate-500">Filters apply to both views</span>
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {active.map(([key, value]) => (
            <button key={key} aria-label={`Remove ${key} filter`} onClick={() => onApply({ ...filters, [key]: "" })}
              className="inline-flex items-center gap-2 rounded-md bg-sky-500/10 ring-1 ring-sky-500/20 px-2.5 py-1 text-[11px] text-sky-300">
              {key === "priority" ? `Activity priority P${value}` : key === "query" ? `Project: ${value}` : value}<X className="h-3 w-3" />
            </button>
          ))}
          <button onClick={() => onApply({ query: "", priority: "", location: "" })} className="text-[11px] text-slate-400 hover:text-white ml-1">Clear all</button>
        </div>
      )}
    </div>
  );
}

export function MonthlyView({ tasks, month, setMonth, onOpenDay, onOpen }) {
  const start = new Date(`${month}-01T00:00:00`);
  const days = calendarDays(month);
  const byDate = new Map();
  tasks.forEach((task) => byDate.set(task.date, [...(byDate.get(task.date) ?? []), task]));
  const changeMonth = (by) => setMonth(isoDate(new Date(start.getFullYear(), start.getMonth() + by, 1)).slice(0, 7));
  const hasEntries = tasks.some((task) => task.date.startsWith(month));

  return (
    <div className="rounded-xl ring-1 ring-slate-800 bg-slate-900/40 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800">
        <h3 className="text-sm font-medium mr-auto">{start.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h3>
        <span className="text-[11px] text-slate-500">Week-start dates · open a day for all possessions</span>
        <button className={button} aria-label="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft className="h-3 w-3" /></button>
        <button className={button} aria-label="Next month" onClick={() => changeMonth(1)}><ChevronRight className="h-3 w-3" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-4 px-4 py-3 border-b border-slate-800 text-[11px]">
        <span className="text-slate-500">Activity priority</span>
        {Object.values(ACTIVITY_PRIORITIES).map(({ label, dot }) => (
          <span key={label} className="flex items-center gap-1.5 text-slate-300"><span className={`h-2 w-2 rounded-full ${dot}`} />{label}</span>
        ))}
      </div>
      {!hasEntries && <p className="px-4 py-3 text-xs text-slate-400">No matching possessions in this month. Choose another month or adjust your filters.</p>}
      <div className="overflow-x-auto">
        <div className="min-w-[700px]">
          <div className="grid grid-cols-7 bg-slate-950/40">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div key={day} className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500">{day}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const date = isoDate(day);
              const entries = byDate.get(date) ?? [];
              const current = day.getMonth() === start.getMonth();
              return (
                <div key={date} className={`min-h-[135px] border-t border-r border-slate-800/70 p-2 ${current ? "" : "bg-slate-950/40"}`}>
                  <div className={`mb-2 text-[11px] ${current ? "text-slate-300" : "text-slate-600"}`}>
                    {day.getDate()}{entries.length > 0 && <span className="float-right text-slate-500">{entries.length} {entries.length === 1 ? "night" : "nights"}</span>}
                  </div>
                  <div className="space-y-1">
                    {entries.slice(0, 2).map((task) => (
                      <button key={task.key} onClick={() => onOpen(task)}
                        aria-label={`${task.contract_number}:${task.activity_id} · ${activityPriority(task).label} · ${date}`}
                        className={`w-full text-left rounded px-2 py-1.5 text-[10px] ring-1 ${activityPriority(task).tone}`}>
                        <span className="block font-mono">{task.contract_number}:{task.activity_id}</span>
                        <span className="block truncate opacity-80">{task.location_id}</span>
                        <span className="block mt-1 font-medium">{activityPriority(task).label}{task.eclo ? " · ECLO" : ""}{task.days_delayed > 0 ? ` · +${task.days_delayed}d` : ""}</span>
                      </button>
                    ))}
                    {entries.length > 2 && <button onClick={() => onOpenDay({ date, tasks: entries })} className="text-[10px] text-slate-400 hover:text-sky-300 px-1">+{entries.length - 2} more possessions</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
