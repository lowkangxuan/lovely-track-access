export default function Metric({ icon: Icon, label, value, tone, description, title }) {
  return (
    <div title={title} className="rounded-lg bg-slate-950/60 ring-1 ring-slate-800 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone || "text-slate-100"}`}>{value}</div>
      {description && <div className="mt-0.5 text-[10px] text-slate-400">{description}</div>}
    </div>
  );
}
