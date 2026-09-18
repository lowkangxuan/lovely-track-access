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

export function matches(task, query, priority, location) {
  const project = query.trim().toLowerCase();
  return (!project || task.contract_number.toLowerCase().includes(project))
    && (!priority || Number(task.activity_priority) === Number(priority))
    && (!location || taskLocations(task).some((id) => {
      if (id === location) return true;
      const [, line, segment] = id.split(":");
      return line === location || segment?.split("_").includes(location);
    }));
}

export function calendarDays(month) {
  const start = new Date(`${month}-01T00:00:00`);
  const offset = (start.getDay() + 6) % 7;
  const last = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + last) / 7) * 7 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), i - offset + 1));
}
