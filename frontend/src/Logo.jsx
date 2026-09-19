/* ------------------------------------------------------------------ *
 * Lovely Track Access — brand mark                                    *
 *                                                                     *
 * An "LTA" monogram standing on a perspective rail track. The letters *
 * and sleepers are knocked out of a sky gradient so the mark stays    *
 * legible from a 16px favicon up to a title slide.                    *
 *                                                                     *
 * Keep this file as the single source of truth for the brand: the     *
 * standalone assets in public/ are exports of the same geometry.      *
 * ------------------------------------------------------------------ */

let gradSeq = 0;

/** The badge on its own — use wherever space is tight (favicon, avatar). */
export function LogoMark({ className = "h-9 w-9", title = "Lovely Track Access" }) {
  // Unique gradient ids so several marks can share a page without one
  // instance's <defs> hijacking another's fill.
  const uid = `lta-${(gradSeq += 1)}`;

  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="45%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#0284c7" />
        </linearGradient>
      </defs>

      {/* badge */}
      <rect x="0" y="0" width="48" height="48" rx="13" fill={`url(#${uid}-bg)`} />
      {/* soft top-left sheen keeps the tile from reading as flat plastic */}
      <path d="M0 13A13 13 0 0 1 13 0h22L0 35Z" fill="#ffffff" opacity="0.14" />

      {/* LTA monogram — geometric strokes, no font dependency */}
      <g
        stroke="#041022"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* L */}
        <path d="M9.5 13.5V28.5H16" />
        {/* T */}
        <path d="M18 13.5H27.5M22.75 13.5V28.5" />
        {/* A */}
        <path d="M29.5 28.5L34 13.5L38.5 28.5M31 23.5H37" />
      </g>

      {/* track running under the monogram, converging away from the viewer */}
      <g stroke="#041022" strokeLinecap="round" fill="none">
        {/* sleepers — nearer ones wider and more solid */}
        <path d="M14.8 35.6H33.2" strokeWidth="1.5" opacity="0.5" />
        <path d="M11.4 38.9H36.6" strokeWidth="1.9" opacity="0.72" />
        <path d="M8 42.2H40" strokeWidth="2.3" opacity="0.92" />
        {/* rails */}
        <path d="M17.6 33.8L8 43" strokeWidth="2.6" />
        <path d="M30.4 33.8L40 43" strokeWidth="2.6" />
      </g>
    </svg>
  );
}

/**
 * The full lock-up: badge + name. The L, T and A are picked out in sky so the
 * "LTA" backronym reads at a glance without spelling it out twice.
 */
export default function Logo({
  mark = "h-9 w-9",
  name = "text-sm font-semibold tracking-tight leading-tight",
  sub = null,
  tag = false,
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <LogoMark className={`${mark} shrink-0`} />
      <div className="min-w-0">
        <h1 className={`${name} text-slate-100`}>
          <span className="text-sky-300">L</span>ovely{" "}
          <span className="text-sky-300">T</span>rack{" "}
          <span className="text-sky-300">A</span>ccess
          {tag && (
            <span className="ml-2 align-middle rounded px-1.5 py-0.5 text-[10px] font-mono font-medium tracking-wider bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/30">
              LTA
            </span>
          )}
        </h1>
        {sub && <p className="text-[11px] text-slate-500 truncate">{sub}</p>}
      </div>
    </div>
  );
}
