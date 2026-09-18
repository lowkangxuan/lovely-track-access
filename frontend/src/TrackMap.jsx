import { networkTracks, parseLocation } from "./schedule-utils.js";

/* ------------------------------------------------------------------ *
 * Schematic of the four directional track paths                      *
 *   Line Alpha EB / WB · Line Beta EB / WB · interchange H01/H02     *
 * Every sector and platform is tagged with its bound, e.g.           *
 *   SEC:ALP:S01_S02:EB · PLAT:BET:S11:WB                             *
 * ------------------------------------------------------------------ */

const COL = 84;      // px per station column
const GUTTER = 96;   // left gutter for the track labels
const TRACK_GAP = 34; // EB track ↔ station axis ↔ WB track
const BLOCK = 128;   // height of one line (both bounds)
const LINE_GAP = 28; // space between the two lines
const PAD_Y = 14;

const LINE_TONES = [
  { track: "stroke-sky-500/40", label: "text-sky-300" },
  { track: "stroke-violet-500/40", label: "text-violet-300" },
];
const LABEL_W = GUTTER - 32;

/** Does the current filter token cover this location id? Mirrors `matches()` in schedule-utils. */
function covers(id, selected) {
  if (!selected) return false;
  if (id === selected) return true;
  const ref = parseLocation(id);
  return !!ref && (ref.line === selected || `${ref.line}:${ref.bound}` === selected || ref.stations.includes(selected));
}

const stateOf = (id, occupied, buffer, selected) => ({
  occupied: occupied.has(id),
  buffer: buffer.has(id),
  selected: covers(id, selected),
});

// Buffer cells use the SVG pattern via the `fill` attribute, so they carry no fill-* class.
const HATCH = "url(#buffer-hatch)";
// Open-line sectors are tunnel (sheltered) or viaduct (exposed to severe weather); platforms are always sheltered.
const KIND_BADGE = {
  tunnel: { label: "Tunnel", tone: "fill-slate-500" },
  viaduct: { label: "Viaduct", tone: "fill-amber-300/90" },
};

const sectorFill = ({ occupied, buffer }) =>
  occupied ? "fill-sky-400" : buffer ? "" : "fill-slate-700";
const platformFill = ({ occupied, buffer }) =>
  occupied ? "fill-sky-400 stroke-sky-200" : buffer ? "stroke-amber-400/70" : "fill-slate-800 stroke-slate-600";

function Clickable({ label, onSelect, token, className = "", children }) {
  const interactive = !!onSelect;
  const activate = () => onSelect?.(token);
  return (
    <g
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={label}
      onClick={interactive ? activate : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } } : undefined}
      className={`${interactive ? "cursor-pointer outline-none focus-visible:[&>*]:stroke-sky-300" : ""} ${className}`}
    >
      <title>{label}</title>
      {children}
    </g>
  );
}

/**
 * `occupied` / `buffer` are Sets of location ids (see `occupancyOverlay`).
 * `selected` is the active location filter token (id, station, line or `LINE:BOUND`).
 * `onSelect(token)` is optional — omit it for a read-only overlay.
 */
export default function TrackMap({ network, occupied = new Set(), buffer = new Set(), selected = "", onSelect, caption }) {
  const lines = networkTracks(network);
  if (!lines.length) {
    return <p className="text-sm text-slate-400">No network map is available for this schedule.</p>;
  }

  const columns = Math.max(...lines.map((line) => line.stations.length));
  const width = GUTTER + (columns - 1) * COL + 40;
  const height = PAD_Y * 2 + lines.length * BLOCK + (lines.length - 1) * LINE_GAP;
  const x = (i) => GUTTER + i * COL;
  const blockTop = (li) => PAD_Y + li * (BLOCK + LINE_GAP);
  const axisY = (li) => blockTop(li) + BLOCK / 2;
  const trackY = (li, bound) => axisY(li) + (bound === "EB" ? -TRACK_GAP : TRACK_GAP);

  // Interchange connectors: same station id appearing on more than one line.
  const interchanges = [];
  lines.forEach((line, li) => line.stations.forEach((s, i) => {
    if (!s.is_interchange) return;
    lines.slice(li + 1).forEach((other, oj) => {
      const j = other.stations.findIndex((t) => t.station_id === s.station_id);
      if (j >= 0) interchanges.push({ id: s.station_id, x1: x(i), y1: trackY(li, "WB"), x2: x(j), y2: trackY(li + 1 + oj, "EB") });
    });
  }));

  const occupiedCount = occupied.size;
  const bufferCount = buffer.size;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-2 scrollbar-thin">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block min-w-max select-none" role="img" aria-label="Network schematic with four directional tracks">
          <defs>
            <pattern id="buffer-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="fill-amber-500/15" />
              <rect width="2.5" height="6" className="fill-amber-400/80" />
            </pattern>
            <marker id="arrow-eb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="fill-slate-500" />
            </marker>
            <marker id="arrow-wb" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M10,0 L0,5 L10,10 z" className="fill-slate-500" />
            </marker>
          </defs>

          {/* interchange links between the lines */}
          {interchanges.map((link) => (
            <g key={`${link.id}-${link.x1}-${link.x2}`}>
              <line x1={link.x1} y1={link.y1 + 8} x2={link.x2} y2={link.y2 - 8} className="stroke-slate-600" strokeWidth="2" strokeDasharray="3 4" />
            </g>
          ))}

          {lines.map((line, li) => {
            const tone = LINE_TONES[li % LINE_TONES.length];
            const first = x(0);
            const last = x(line.stations.length - 1);
            return (
              <g key={line.line_code}>
                {/* line name */}
                <Clickable label={`Filter ${line.line_name} (all tracks)`} onSelect={onSelect} token={line.line_code}>
                  <text x={8} y={blockTop(li) + 6} className={`text-[11px] font-medium ${tone.label} fill-current`}>{line.line_name}</text>
                  <text x={8} y={blockTop(li) + 20} className="text-[9px] fill-slate-500">{line.line_code}</text>
                </Clickable>

                {line.tracks.map((track) => {
                  const y = trackY(li, track.bound);
                  const eb = track.bound === "EB";
                  return (
                    <g key={track.id}>
                      {/* directional track label */}
                      <Clickable label={`Filter ${line.line_name} ${eb ? "Eastbound" : "Westbound"} track`} onSelect={onSelect} token={track.id}>
                        <rect x={8} y={y - 9} width={LABEL_W} height={18} rx="4" className={selected === track.id ? "fill-sky-500/25" : "fill-slate-800/80"} />
                        <text x={8 + LABEL_W / 2} y={y + 3.5} textAnchor="middle" className="text-[10px] font-mono fill-slate-200">
                          {line.line_code} {track.bound} {eb ? "→" : "←"}
                        </text>
                      </Clickable>

                      {/* base rail with a direction arrow */}
                      <line
                        x1={eb ? first : last} y1={y} x2={eb ? last + 22 : first - 16} y2={y}
                        className={tone.track} strokeWidth="2"
                        markerEnd={eb ? "url(#arrow-eb)" : "url(#arrow-wb)"}
                      />

                      {/* sectors */}
                      {track.sectors.map((sector) => {
                        const st = stateOf(sector.location_id, occupied, buffer, selected);
                        const left = Math.min(sector.from_index, sector.to_index);
                        const right = Math.max(sector.from_index, sector.to_index);
                        const status = st.occupied ? " · occupied" : st.buffer ? " · buffer exclusion" : "";
                        const badge = KIND_BADGE[sector.sector_kind];
                        return (
                          <Clickable key={sector.location_id} label={`${sector.location_id}${badge ? ` · ${badge.label}` : ""}${status}`} onSelect={onSelect} token={sector.location_id}>
                            {eb && badge && (
                              <text x={(x(left) + x(right)) / 2} y={y - 9} textAnchor="middle" className={`text-[8px] uppercase tracking-wide ${badge.tone}`}>
                                {badge.label}
                              </text>
                            )}
                            <rect
                              x={x(left) + 14} y={y - 4} width={x(right) - x(left) - 28} height={8} rx="2"
                              fill={st.buffer && !st.occupied ? HATCH : undefined}
                              className={`${sectorFill(st)} ${st.selected ? "stroke-white" : "stroke-transparent"} transition-colors`}
                              strokeWidth={st.selected ? 1.5 : 0}
                            />
                            {sector.is_shared === 1 && (
                              <rect x={x(left) + 14} y={y - 4} width={x(right) - x(left) - 28} height={8} rx="2" className="fill-none stroke-slate-400" strokeWidth="1" strokeDasharray="2 2" />
                            )}
                          </Clickable>
                        );
                      })}

                      {/* platforms */}
                      {track.platforms.map((platform) => {
                        const st = stateOf(platform.location_id, occupied, buffer, selected);
                        const status = st.occupied ? " · occupied" : st.buffer ? " · buffer exclusion" : "";
                        return (
                          <Clickable key={platform.location_id} label={`${platform.location_id}${status}`} onSelect={onSelect} token={platform.location_id}>
                            <rect
                              x={x(platform.index) - 9} y={y - 7} width={18} height={14} rx="3"
                              fill={st.buffer && !st.occupied ? HATCH : undefined}
                              className={`${platformFill(st)} ${st.selected ? "!stroke-white" : ""} transition-colors`}
                              strokeWidth={st.selected ? 2 : 1}
                            />
                          </Clickable>
                        );
                      })}
                    </g>
                  );
                })}

                {/* station axis between the two bounds */}
                <line x1={first} y1={axisY(li)} x2={last} y2={axisY(li)} className="stroke-slate-800" strokeWidth="1" />
                {line.stations.map((station, i) => {
                  const active = selected === station.station_id;
                  const inter = station.is_interchange === 1;
                  return (
                    <Clickable key={station.station_id} label={`Filter station ${station.station_id}${inter ? " (interchange)" : ""}`} onSelect={onSelect} token={station.station_id}>
                      {/* vertical tie from EB platform to WB platform */}
                      <line x1={x(i)} y1={trackY(li, "EB") + 7} x2={x(i)} y2={trackY(li, "WB") - 7} className="stroke-slate-800" strokeWidth="1" />
                      {inter ? (
                        <rect x={x(i) - 7} y={axisY(li) - 7} width={14} height={14} rx="2" transform={`rotate(45 ${x(i)} ${axisY(li)})`}
                          className={`${active ? "fill-white stroke-sky-400" : "fill-slate-900 stroke-amber-300"}`} strokeWidth="2.5" />
                      ) : (
                        <circle cx={x(i)} cy={axisY(li)} r="6" className={`${active ? "fill-white stroke-sky-400" : "fill-slate-900 stroke-slate-400"}`} strokeWidth="2.5" />
                      )}
                      <text x={x(i)} y={axisY(li) + TRACK_GAP - 14} textAnchor="middle" className="text-[10px] font-mono fill-slate-200">
                        {station.station_id}
                      </text>
                    </Clickable>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-sky-400" /> occupied ({occupiedCount})</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-[repeating-linear-gradient(45deg,rgb(251_191_36/0.8)_0_2px,rgb(245_158_11/0.15)_2px_5px)]" /> buffer exclusion ({bufferCount})</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-slate-700" /> free</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rotate-45 rounded-[2px] border-2 border-amber-300" /> interchange</span>
        <span className="flex items-center gap-1.5"><span className="text-[8px] uppercase tracking-wide text-amber-300/90">Viaduct</span> exposed sector</span>
        <span className="flex items-center gap-1.5"><span className="text-[8px] uppercase tracking-wide text-slate-500">Tunnel</span> sheltered sector</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-slate-700 ring-1 ring-white" /> selected</span>
        {caption && <span className="ml-auto">{caption}</span>}
      </div>
    </div>
  );
}
