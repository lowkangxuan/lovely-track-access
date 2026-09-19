import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Clock,
  CloudLightning,
  FileSpreadsheet,
  Gauge,
  Moon,
  Play,
  RefreshCw,
  Rocket,
  Route,
  Upload,
  Users,
  XCircle,
} from "lucide-react";

import Metric from "./Metric.jsx";
import TeamAllocationsModal from "./TeamAllocations.jsx";
import { matchSchemaName, validateHeaders } from "./schedule-utils.js";

/* ------------------------------------------------------------------ *
 * Editor's View — full-page, two-panel re-optimisation workflow      *
 *   left  : 8 instance CSVs + scenario → "Preview"                   *
 *   right : solver evaluation of that preview → "Implement Schedule" *
 * ------------------------------------------------------------------ */

export const SCENARIOS = [
  { id: "A", name: "Scenario A", label: "Strict Supply, Flexible Schedule", hint: "Capacity is rigid. ECLO forbidden. Minimise priority-weighted overrun." },
  { id: "B", name: "Scenario B", label: "Strict Schedule, Flexible Supply", hint: "Planned dates are rigid. Pay with extra access-nights and ECLO." },
  { id: "C", name: "Scenario C", label: "Elastic Supply, Flexible Schedule", hint: "Both flex. +1 excess access-night per location-week allowed." },
];

const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/** Parse only the header row — enough to validate, cheap on large files. */
function readHeaderRow(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const text = String(reader.result || "").replace(/^﻿/, "");
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      resolve({
        headers: (lines[0] || "").split(",").map((h) => h.trim().replace(/^"|"$/g, "")),
        rowCount: Math.max(0, lines.length - 1),
      });
    };
    reader.readAsText(file.slice(0, 64 * 1024));
  });
}

/** Validate one File against the schema for `name`; returns the slot entry. */
async function inspect(name, file, schemas) {
  try {
    const { headers, rowCount } = await readHeaderRow(file);
    return { file, rowCount, ...validateHeaders(name, headers, schemas) };
  } catch {
    return { file, rowCount: 0, ok: false, message: `${name} could not be read.` };
  }
}

/* ---- one row in the CSV column ----------------------------------- */

function FileSlot({ name, required, entry, onFile, onClear, optional = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const pick = (files) => { const file = files?.[0]; if (file) onFile(file); };
  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files); },
  };
  const input = (
    <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
      onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
  );

  if (!entry) {
    return (
      <li {...dropProps}>
        <button type="button" onClick={() => inputRef.current?.click()}
          className={`w-full text-left rounded-xl border-2 border-dashed px-4 py-3 transition-colors ${dragging ? "border-sky-400 bg-sky-500/5" : "border-slate-700 hover:border-slate-500 bg-slate-950/40"}`}>
          <div className="flex items-center gap-3">
            <Upload className="h-4 w-4 text-slate-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-200">{name}</span>
                {optional && <span className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-slate-800 text-slate-400 ring-1 ring-slate-700">Optional</span>}
              </div>
              <div className="text-[10px] text-slate-500 truncate" title={required.join(", ")}>Drop here or click to upload · {required.length} columns</div>
            </div>
          </div>
        </button>
        {input}
      </li>
    );
  }

  return (
    <li {...dropProps} className={`rounded-xl px-4 py-3 ring-1 transition-colors ${
      dragging ? "ring-sky-400 bg-sky-500/5" : entry.ok ? "bg-emerald-500/5 ring-emerald-500/25" : "bg-rose-500/5 ring-rose-500/25"}`}>
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 shrink-0 ${
          entry.ok ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "bg-rose-500/15 text-rose-300 ring-rose-500/30"}`}>
          {entry.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {entry.ok ? "Uploaded" : "Invalid"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-200">{name}</span>
            {optional && <span className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-slate-800 text-slate-400 ring-1 ring-slate-700">Optional</span>}
          </div>
          <div className="text-[10px] text-slate-500 truncate">
            {entry.file.name}{entry.ok ? ` · ${entry.rowCount} row${entry.rowCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()} className={`${button} !py-1.5 shrink-0`}>
          <RefreshCw className="h-3 w-3" /> Update file
        </button>
        {optional && onClear && (
          <button type="button" onClick={onClear} aria-label={`Remove ${name}`} className={`${button} !px-2 !py-1.5 shrink-0`}>
            <XCircle className="h-3 w-3" />
          </button>
        )}
      </div>
      {!entry.ok && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-200">
          <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" /> <span className="break-words">{entry.message}</span>
        </p>
      )}
      {input}
    </li>
  );
}

/* ---- right-panel evaluation --------------------------------------- */

function Evaluation({ preview }) {
  const ev = preview.evaluation ?? {};
  const violations = preview.hard_violations ?? [];
  const alloc = preview.allocation ?? {};
  // null (rather than 0) whenever no 09_FLEET_DATA.csv rode along with the solve
  const avgDistance = alloc.avg_travel_distance ?? preview.avg_travel_distance ?? null;
  const matchRate = alloc.expertise_match_rate ?? preview.expertise_match_rate ?? null;
  return (
    <div className="space-y-4">
      <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ring-1 ${
        preview.feasible ? "bg-emerald-500/10 ring-emerald-500/30" : "bg-rose-500/10 ring-rose-500/30"}`}>
        {preview.feasible ? <CheckCircle2 className="h-5 w-5 text-emerald-300" /> : <AlertTriangle className="h-5 w-5 text-rose-300" />}
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${preview.feasible ? "text-emerald-300" : "text-rose-300"}`}>
            {preview.feasible ? "Feasible — all hard constraints satisfied" : `Infeasible — ${violations.length} hard violation${violations.length === 1 ? "" : "s"}`}
          </p>
          <p className="text-[11px] text-slate-400 truncate">
            Scenario {preview.scenario} · {preview.scenario_label} · {preview.counts?.activities_scheduled} / {preview.counts?.activities_total} activities scheduled · solved in {preview.runtime_ms} ms
          </p>
          {preview.weather_enabled && (
            <p className="text-[11px] text-sky-300/90 truncate">
              Weather-aware · {preview.weather?.days?.filter((d) => d.severe).length ?? 0} severe days in {preview.weather_severe_weeks?.length ?? 0} weeks · {preview.weather_outages} viaduct access-nights withdrawn
              {preview.weather?.analogue_year ? ` · analogue year ${preview.weather.analogue_year}` : ""}
              {preview.weather_outages > 0 && !(preview.evaluation?.overrun_days_total || preview.evaluation?.excess_access_nights_total || preview.evaluation?.eclo_nights_total)
                ? " · absorbed within slack, no score penalty" : ""}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric icon={Moon} label="Total access nights" value={ev.access_nights_total ?? preview.tasks?.length ?? "—"} />
        <Metric icon={Clock} label="Contract overrun days" value={ev.overrun_days_total ?? "—"}
          description={`Across ${ev.contracts_overrunning ?? 0} contract${ev.contracts_overrunning === 1 ? "" : "s"}`}
          tone={ev.overrun_days_total > 0 ? "text-amber-300" : "text-emerald-300"} />
        <Metric icon={Moon} label="ECLO nights" value={ev.eclo_nights_total ?? "—"} tone={ev.eclo_nights_total ? "text-amber-300" : ""} />
        <Metric icon={Gauge} label="Combined objective score" value={ev.objective_score ?? "—"}
          description={preview.feasible ? "Lower is better" : "Not scored — infeasible"} tone={preview.feasible ? "text-sky-300" : "text-slate-400"} />

        {/* --- manpower allocation KPIs (09_FLEET_DATA.csv) --- */}
        <Metric icon={Route} label="Average travel distance"
          value={avgDistance != null ? `${avgDistance.toFixed(1)} km` : "—"}
          title="Mean straight-line distance from each assigned crew's base to its worksite centroid."
          tone={avgDistance != null ? "text-sky-300" : "text-slate-400"}
          description={avgDistance != null
            ? `${alloc.teams_utilised ?? 0} of ${alloc.teams_total ?? 0} teams · ${alloc.total_travel_distance ?? 0} km total`
            : "Upload 09_FLEET_DATA.csv"} />
        <Metric icon={Users} label="Expertise match rate"
          value={matchRate != null ? `${matchRate.toFixed(1)}%` : "—"}
          title="Share of assignments where the crew meets both the required specialty and the required tier."
          tone={matchRate == null ? "text-slate-400" : matchRate >= 100 ? "text-emerald-300" : "text-amber-300"}
          description={matchRate != null
            ? (alloc.unmatched_expertise
                ? `${alloc.unmatched_expertise} below required tier`
                : `All ${alloc.activities_allocated ?? 0} worksites fully matched`)
            : "Upload 09_FLEET_DATA.csv"} />
      </div>

      {ev.excess_access_nights_total > 0 && (
        <p className="text-[11px] text-slate-400">{ev.excess_access_nights_total} excess access night{ev.excess_access_nights_total === 1 ? "" : "s"} beyond planned supply.</p>
      )}

      {violations.length > 0 && (
        <div className="rounded-xl bg-rose-500/5 ring-1 ring-rose-500/25 px-4 py-3">
          <div className="text-xs font-medium text-rose-200 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5" /> Hard violations</div>
          <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto scrollbar-thin">
            {violations.slice(0, 25).map((v, i) => (
              <li key={i} className="text-[11px] text-rose-200/80"><span className="font-mono text-rose-300">{v.rule}</span> — {v.detail}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---- the page ----------------------------------------------------- */

/**
 * `draft` = { entries, scenario } lifted to App so reopening the editor keeps the uploads.
 * `onImplement(preview)` must resolve once the schedule is active (it may throw to surface an error here).
 */
export default function EditorView({ schemas, optionalSchemas = {}, apiBase, draft, onDraftChange, onBack, onImplement }) {
  const schemaNames = useMemo(() => Object.keys(schemas), [schemas]);
  const optionalNames = useMemo(() => Object.keys(optionalSchemas), [optionalSchemas]);
  // one registry for uploads and validation; only `schemaNames` gates Preview
  const allSchemas = useMemo(() => ({ ...schemas, ...optionalSchemas }), [schemas, optionalSchemas]);
  const allNames = useMemo(() => [...schemaNames, ...optionalNames], [schemaNames, optionalNames]);
  const [entries, setEntries] = useState(draft?.entries ?? {});
  const [scenario, setScenario] = useState(draft?.scenario ?? null);
  const [weatherAware, setWeatherAware] = useState(!!draft?.weatherAware); // default OFF
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const [error, setError] = useState("");
  const [showAllocations, setShowAllocations] = useState(false);
  const bulkRef = useRef(null);

  useEffect(() => { onDraftChange?.({ entries, scenario, weatherAware }); }, [entries, scenario, weatherAware, onDraftChange]);
  useEffect(() => {
    // Escape closes the allocations modal first; the dialog's own onCancel does that.
    const onKey = (e) => e.key === "Escape" && !previewing && !implementing && !showAllocations && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, previewing, implementing, showAllocations]);

  const setFile = useCallback(async (name, file) => {
    const entry = await inspect(name, file, allSchemas);
    setEntries((prev) => ({ ...prev, [name]: entry }));
    setPreview(null); // inputs changed — the previous evaluation no longer applies
  }, [allSchemas]);

  const clearFile = useCallback((name) => {
    setEntries((prev) => { const { [name]: _drop, ...rest } = prev; return rest; });
    setPreview(null);
  }, []);

  /** Route a batch of files to their slots by filename; report the strays. */
  const addMany = useCallback(async (fileList) => {
    const strays = [];
    for (const file of Array.from(fileList || [])) {
      const name = matchSchemaName(file.name, allNames);
      if (name) await setFile(name, file);
      else strays.push(file.name);
    }
    setError(strays.length ? `Not one of the recognised instance files: ${strays.join(", ")}` : "");
  }, [allNames, setFile]);

  const validCount = schemaNames.filter((n) => entries[n]?.ok).length;
  const allValid = validCount === schemaNames.length;
  const canPreview = allValid && !!scenario && !previewing && !implementing;
  const fleetEntries = optionalNames.filter((n) => entries[n]?.ok);
  const hasAllocations = (preview?.allocation?.team_allocations?.length ?? 0) > 0;

  const runPreview = async () => {
    setPreviewing(true);
    setError("");
    try {
      const form = new FormData();
      form.append("scenario", scenario);
      form.append("weather_enabled", weatherAware ? "true" : "false"); // read by POST /api/reschedule
      schemaNames.forEach((n) => form.append("files", entries[n].file, n));
      // optional extras (09_FLEET_DATA.csv) ride along under the same `files` field
      fleetEntries.forEach((n) => form.append("files", entries[n].file, n));
      const res = await fetch(`${apiBase}/api/reschedule`, { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body?.detail;
        throw new Error(typeof detail === "string" ? detail : detail?.message || `Preview failed (${res.status})`);
      }
      // A backend that predates weather-aware scheduling ignores the field silently — say so instead of showing an unchanged score.
      if (body.weather_enabled !== weatherAware) {
        throw new Error("The scheduler API ignored weather_enabled — restart the FastAPI backend so the weather-aware solver is loaded.");
      }
      setPreview(body);
    } catch (e) {
      setPreview(null);
      setError(e.message || "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  };

  const implement = async () => {
    if (!preview) return;
    setImplementing(true);
    setError("");
    try {
      await onImplement(preview);
    } catch (e) {
      setError(e.message || "Could not implement the schedule.");
      setImplementing(false);
    }
  };

  const panel = "flex flex-col min-h-0 rounded-2xl bg-slate-900/60 ring-1 ring-slate-800";
  const panelHead = "px-5 py-3 border-b border-slate-800 flex items-center gap-2";
  const panelFoot = "px-5 py-3 border-t border-slate-800 flex flex-wrap items-center gap-3";

  return (
    <div className="fixed inset-0 z-40 bg-slate-950 text-slate-100 flex flex-col">
      {/* page header */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center gap-3">
          <button onClick={onBack} disabled={previewing || implementing} className={button}>
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight leading-tight">Editor's View</h1>
            <p className="text-[11px] text-slate-500 truncate">Upload instance CSVs, choose a scenario, preview the solve, then implement it as the active schedule.</p>
          </div>
          <span className="ml-auto text-[11px] text-slate-500">{validCount} / {schemaNames.length} files valid{fleetEntries.length ? ` · +${fleetEntries.length} optional` : ""}{scenario ? ` · Scenario ${scenario}` : ""}{weatherAware ? " · weather-aware" : ""}</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 mx-auto w-full max-w-[1400px] px-4 sm:px-6 py-4 grid gap-4 lg:grid-cols-2">
        {/* ---------- LEFT: configuration & inputs ---------- */}
        <section className={panel} aria-label="Configuration and inputs"
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addMany(e.dataTransfer.files); }}>
          <div className={panelHead}>
            <FileSpreadsheet className="h-4 w-4 text-sky-300" />
            <h2 className="text-sm font-medium whitespace-nowrap">Instance files</h2>
            <span className="hidden xl:inline text-[11px] text-slate-500 truncate">· headers validated client-side against the schema registry</span>
            <button type="button" onClick={() => bulkRef.current?.click()} className={`${button} ml-auto !py-1.5`}>
              <Upload className="h-3 w-3" /> Add several
            </button>
            <input ref={bulkRef} type="file" multiple accept=".csv,text/csv" className="hidden"
              onChange={(e) => { addMany(e.target.files); e.target.value = ""; }} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4 space-y-5">
            <ul className="space-y-2">
              {schemaNames.map((name) => (
                <FileSlot key={name} name={name} required={schemas[name]} entry={entries[name]} onFile={(file) => setFile(name, file)} />
              ))}
            </ul>

            {optionalNames.length > 0 && (
              <div>
                <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                  <Users className="h-3 w-3" /> Fleet &amp; manpower
                  <span className="normal-case tracking-normal text-slate-500">· optional, does not block preview</span>
                </h3>
                <ul className="space-y-2">
                  {optionalNames.map((name) => (
                    <FileSlot key={name} name={name} required={optionalSchemas[name]} entry={entries[name]}
                      optional onFile={(file) => setFile(name, file)} onClear={() => clearFile(name)} />
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-slate-500">
                  Supplying fleet data enables travel-distance and expertise-match scoring, and the team allocation review.
                </p>
              </div>
            )}

            {/* weather-aware toggle — leaning right, between uploads and scenarios */}
            <div className="flex justify-end">
              <div
                className={`w-full sm:w-auto sm:min-w-[300px] max-w-full overflow-hidden flex items-center justify-between gap-4 rounded-xl px-4 py-2.5 ring-1 transition-colors ${
                  weatherAware ? "bg-sky-500/10 ring-sky-500/40" : "bg-slate-950/40 ring-slate-800"}`}
                title="Severe weather days withdraw possession nights from outdoor viaduct sectors; tunnels and platforms are unaffected."
              >
                <span className="flex items-center gap-2 min-w-0">
                  <CloudLightning className={`h-4 w-4 shrink-0 ${weatherAware ? "text-sky-300" : "text-slate-500"}`} />
                  <span id="weather-toggle-label" className="text-sm font-medium text-slate-200 truncate">Weather-Aware Scheduling</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-medium tabular-nums ${weatherAware ? "text-sky-300" : "text-slate-500"}`}>{weatherAware ? "ON" : "OFF"}</span>
                  <button type="button" role="switch" aria-checked={weatherAware} aria-labelledby="weather-toggle-label"
                    onClick={() => { setWeatherAware((v) => !v); setPreview(null); }}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 ${weatherAware ? "bg-sky-500" : "bg-slate-700"}`}>
                    <span className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow transition-transform ${weatherAware ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                  </button>
                </span>
              </div>
            </div>

            <div>
              <h3 className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Scenario</h3>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Scenario selection">
                {SCENARIOS.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={scenario === s.id}
                    onClick={() => { setScenario(s.id); setPreview(null); }} title={s.hint}
                    className={`text-left rounded-xl px-3 py-3 ring-1 transition-colors ${
                      scenario === s.id ? "bg-sky-500/10 ring-sky-500/50" : "bg-slate-950/40 ring-slate-800 hover:ring-slate-600"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-5 w-5 rounded-md grid place-items-center text-[11px] font-semibold ${
                        scenario === s.id ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-300"}`}>{s.id}</span>
                      <span className="text-xs text-slate-100">{s.name}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-300 leading-snug">{s.label}</p>
                    <p className="mt-1 text-[10px] text-slate-500 leading-snug">{s.hint}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={panelFoot}>
            <p className="text-[11px] text-slate-500 flex-1">
              {canPreview ? "Ready to evaluate." : !allValid ? `Upload all ${schemaNames.length} valid files to enable preview.` : !scenario ? "Choose a scenario to enable preview." : "Working…"}
            </p>
            <button type="button" disabled={!canPreview} onClick={runPreview}
              className={`rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors ${
                canPreview ? "bg-sky-500 hover:bg-sky-400 text-slate-950" : "bg-slate-800 text-slate-500 cursor-not-allowed"}`}>
              {previewing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Preview
            </button>
          </div>
        </section>

        {/* ---------- RIGHT: preview & evaluation ---------- */}
        <section className={panel} aria-label="Preview and evaluation" aria-busy={previewing}>
          <div className={panelHead}>
            <Gauge className="h-4 w-4 text-sky-300" />
            <h2 className="text-sm font-medium whitespace-nowrap">Preview &amp; evaluation</h2>
            {preview && <span className="ml-auto font-mono text-[10px] text-slate-500">run {preview.run_id?.slice(0, 8)}</span>}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4">
            {error && (
              <div className="mb-4 rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-sm text-rose-200 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <span className="break-words">{error}</span>
              </div>
            )}
            {previewing ? (
              <div className="h-full min-h-[240px] grid place-items-center text-center">
                <div>
                  <RefreshCw className="h-6 w-6 text-sky-300 animate-spin mx-auto" />
                  <p className="mt-3 text-sm text-slate-200">Re-solving Scenario {scenario}…</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Packing co-share slots and checking buffers…</p>
                </div>
              </div>
            ) : preview ? (
              <Evaluation preview={preview} />
            ) : (
              <div className="h-full min-h-[240px] grid place-items-center text-center">
                <div>
                  <ClipboardList className="h-8 w-8 text-slate-600 mx-auto" />
                  <p className="mt-3 text-sm text-slate-300">Click ‘Preview’ to evaluate schedule</p>
                  <p className="text-[11px] text-slate-500 mt-1">The solver runs on your uploaded instance; nothing changes on the dashboard until you implement it.</p>
                </div>
              </div>
            )}
          </div>

          <div className={panelFoot}>
            <p className="text-[11px] text-slate-500 flex-1 min-w-[140px]">
              {preview ? (preview.feasible ? "Implementing replaces the active schedule and returns to the dashboard." : "This preview is infeasible — implement only if you accept the violations.") : "Evaluate a preview to enable."}
            </p>
            <button type="button" disabled={!preview || previewing || implementing} onClick={() => setShowAllocations(true)}
              title={hasAllocations
                ? "Inspect the crew assigned to every scheduled worksite"
                : "No fleet data in this run — upload 09_FLEET_DATA.csv to populate allocations"}
              className={`rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 ring-1 transition-colors ${
                preview && !previewing && !implementing
                  ? "ring-sky-500/40 text-sky-300 bg-sky-500/5 hover:bg-sky-500/15"
                  : "ring-slate-800 text-slate-500 cursor-not-allowed"}`}>
              <Users className="h-4 w-4" /> Review Team Allocations
              {hasAllocations && (
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] tabular-nums">{preview.allocation.team_allocations.length}</span>
              )}
            </button>
            <button type="button" disabled={!preview || previewing || implementing} onClick={implement}
              className={`rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors ${
                preview && !previewing && !implementing ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950" : "bg-slate-800 text-slate-500 cursor-not-allowed"}`}>
              {implementing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Implement Schedule
            </button>
          </div>
        </section>
      </div>

      {showAllocations && preview && (
        <TeamAllocationsModal allocation={preview.allocation} scenario={preview.scenario}
          onClose={() => setShowAllocations(false)} />
      )}
    </div>
  );
}
