# Railway Track Access Scheduler & Fleet Allocator

**PS1 — Dual-Line Railway Track Access Optimisation (Line Alpha & Line Beta)**

> 🌐 **Live app:** `<INSERT_LIVE_URL>`
> 🎥 **3-minute demo:** `<INSERT_YOUTUBE_URL>`
> 💻 **Source:** https://github.com/lowkangxuan/nebula-x
> 📊 **Public test results:** `03_results/{A,B,C}/` — one full submission set per scenario

---

## 💡 Inspiration

Between the last train and the first, a railway gets about four hours. Everything physical that has to happen to the network — rail renewals, construction, signalling — competes for those hours, and the competition is brutal: fourteen contracts, fifty-four activities, two lines, and a tunnel at the H01–H02 interchange that physically belongs to both lines at once.

Today a works controller resolves that by hand. They hold the exclusion buffers in their head, remember that a live-rail job cuts traction power and therefore closes the *opposite* bound too, check that no contract has burned through its weekly access-night allocation, and confirm that nothing starts before its predecessor has finished. Then a defect gets reported on a Tuesday, a location's nightly quota drops from four to one, and the whole thing is re-planned by hand at 2 AM.

What struck us reading the problem statement was a single line: *"The plan you produce is not advisory."* A schedule that's 95% right isn't 95% useful — it's a safety incident waiting for a night to happen on. That reframed the build. We weren't making a planning aid. We were making something whose output a controller could dispatch against without re-deriving it, which meant the tool had to be able to **prove** its answer, not merely produce one.

## 🚂 What It Does

The Scheduler ingests the eight instance CSVs describing a planning horizon — network topology, location supply, buffer rules, contracts, activities — and returns a complete, dispatchable possession schedule for whichever policy scenario you pick:

- **Scenario A — Strict Supply, Flexible Schedule.** Capacity is rigid, ECLO forbidden. The only lever is which contract's overrun to absorb, cheapest tier first.
- **Scenario B — Strict Schedule, Flexible Supply.** Dates are immovable. Pay for them with extra access-nights and early-closure/late-opening.
- **Scenario C — Elastic Trade-off.** Both flex, with a narrow one-excess-night-per-location-week allowance and a two-week ECLO continuity window per line.

On the reference instance all three come back **feasible with the full workload placed — 54 of 54 activities, zero hard violations**, solved in well under a second each:

| Scenario | Feasible | Scheduled | Overrun days | ECLO | Excess nights | Objective |
| --- | --- | --- | --- | --- | --- | --- |
| A | ✅ | 54 / 54 | 21 (C006 +14, C010 +7) | 0 | 0 | **25.2** |
| B | ✅ | 54 / 54 | 0 | 6 | 0 | **30.0** |
| C | ✅ | 54 / 54 | 21 (C006 +14, C010 +7) | 0 | 0 | **25.2** |

C converging on A is not a bug — it's the model telling us something. With overrun weighted at 1×/day for tier-3 contracts, neither an ECLO night (5) nor an excess access-night (7) buys enough schedule to pay for itself. The trade-off engine priced the levers and declined to use them.

Around the solver sits a works-controller dashboard: a sticky week-by-week timeline, role-scoped views (an engineer on C001 sees only C001), a network schematic you click to filter by sector, a scenario rubric breakdown showing exactly which penalties produced the score, and a two-panel Editor's View where you upload an instance, preview the solve, inspect it, and only then implement it.

And a layer the brief didn't ask for: **crew allocation**. Drop in an optional ninth file of fleet data and the tool assigns the nearest *qualified* engineering team to every scheduled worksite, then reports what that costs in travel.

## 🔧 How We Built It

**Backend — FastAPI + OR-Tools CP-SAT.** The solver is a time-indexed constraint program over `(activity, week, possession-night)` booleans, seeded by a multi-start greedy construction. That pairing is deliberate. The greedy *always* finishes the full workload — extending the calendar under congestion rather than dropping work — so there is always a complete incumbent to fall back on. CP-SAT then minimises the scenario objective within the incumbent's horizon and reports its search status. If it can't improve inside the time limit, the seed ships with `detail.fallback_used = true`. **The tool never returns "infeasible" as an answer**, which is precisely what the non-negotiables demand.

**The part we're most glad we built: an independent validator.** `solver/validation.py` re-checks every emitted schedule against all ten hard rules — workload conservation, planned start, predecessor FS+0, closures and buffers, legal possession mixes, co-sharing, weekly allocation, workfronts, ECLO, ECLO continuity — with no shared code path with the solver that produced it. A solver that believes its own output is a solver that ships breaches.

**The one seam.** `solver/registry.py` takes any callable of shape `solve(scenario, data) -> SolveOutput`. Registering a new solver changes nothing else — not the API contract, not the CSV writers, not a line of the UI. It let us swap the greedy baseline for CP-SAT mid-build with zero downstream churn, and it's how a future team swaps ours out.

**Weather-aware scheduling (Open-Meteo).** Our one external API integration, and it earns its place. Severe weather days withdraw possession nights from *outdoor viaduct sectors only* — tunnels and platforms are sheltered and keep their full supply. Reduced capacities flow into the unchanged scenario scoring, so weather pressure surfaces as overrun, ECLO and excess nights in the same units as everything else. Responses are cached to disk against an analogue year, so a demo never depends on a live network call.

**Frontend — React 18 + Tailwind + Vite.** Three runtime dependencies total: React, React DOM, and an icon set. No component library, no chart library, no map SDK. Every visualisation is hand-built SVG or CSS, which kept the bundle honest and the rendering fully under our control.

## 🧗 Challenges We Ran Into

**Our first UI let an administrator overwrite reality with an experiment.** The original flow had exactly one schedule: upload the instance, solve, and what came back *was* the plan. It took us far too long to notice what that meant in a real access-planning office. An admin comparing Scenario B against Scenario C — an entirely normal thing to want to do — would be writing every attempt straight into the live schedule, and any site engineer logged in at that moment would read a half-tested experiment as the plan for their Tuesday night. A comparison tool that silently publishes is worse than no comparison tool at all. With days left on the clock, we rebuilt the admin path as a separate **rescheduling page**: upload a candidate instance, pick a scenario, and *evaluate a preview* — feasible or not, every hard violation listed, access nights, contract overrun days, ECLO nights and the combined objective score — without touching a single thing the engineers see. Swap one CSV, or switch A → B → C, re-evaluate, and compare the numbers side by side. The live schedule moves only when the admin presses **Implement Schedule**, deliberately, on a preview they have already read. The feature we nearly shipped without is now the one an admin spends most of their time in.

**Two features the brief never asked for — and the fear of being punished for adding them.** Manpower optimisation and weather-aware scheduling were both outside the problem statement, and we genuinely stalled on them. The submission is scored by a reference validator against ten hard rules and a fixed objective; anything we bolted on that nudged the solver could turn a clean, feasible schedule into a worse one, or a rejected one. Cleverness that costs you the mandatory gate is not cleverness. The way out was architectural rather than a judgement call: both ride as **strictly optional layers**. Weather-awareness is a toggle that defaults OFF. The fleet data arrives as a ninth CSV in its own optional registry, so the eight required files still gate Preview on their own. With both off — which is exactly how a judge's hidden instance arrives — the solve follows the same code path it always did and the new metrics report `null` instead of a fabricated `0`. Turned on, they layer on top: severe weather withdraws possession nights from outdoor viaduct sectors only, and the reduced capacity flows through the *unchanged* scenario scoring, so weather pressure surfaces as overrun and ECLO in the same units as everything else. No new objective, no special-casing, nothing to explain away.

**The stations had no coordinates.** The crew allocation feature needs distance, and `02_STATIONS.csv` ships a per-line running order and nothing else — no X, no Y. We reconstructed the plane from `seq` (`x = (seq-1) × spacing`, `y = line_index × line_gap`), with both spacings overridable from the parameters file. The subtle part was the interchange: H01 appears on both lines, so a naive build places it at two different points. We average its per-line positions, so the interchange resolves to **one physical place** — which is what it is.

**The 90-degree trap.** Our bearing arrows (`↗ NE`) come from `atan2(ΔY, ΔX)`. That measures anticlockwise from **east**, not north. List the eight compass points starting at North, index them `round(θ/45)`, and every arrow in the table is silently rotated 90° — it looks plausible, it's just wrong. We caught it by writing the test first, then pinned it with a second test that re-derives each row's quadrant from the raw sign of the deltas and asserts the label agrees.

**A visualisation that was technically correct and practically blank.** The micro scatter plot puts the worksite at the centre of a 40px box and the crew at true bearing and scaled distance. Scaled linearly, **31 of 54 crew dots landed within 2px of the worksite dot** — visually merged, glyph empty for most of the table. The fleet's journeys are mostly short against one 21 km outlier. Switching magnitude to a square-root scale — direction still exact, still monotonic, so rows stay comparable — brought that to **0 of 54**, with the outlier still pinned to the same edge. We only found it because we simulated all 54 real rows through the render maths instead of eyeballing a screenshot.

**Numbers that didn't add up.** Our allocations table shows travel distance, the nearest eligible crew's distance, and the detour between them, side by side. A test caught that the detour was computed from *unrounded* distances while the two figures beside it were each rounded independently — so occasionally the three displayed numbers were internally inconsistent by 0.01 km. Small, but it's a table a controller is meant to trust.

**A dark-mode bug hiding in plain sight.** `index.html` carried `<html class="dark">`, but `tailwind.config.js` never set `darkMode`, so Tailwind was on its `media` default — the class was inert and `dark:` variants were quietly following the *visitor's OS setting*. Since the app is unconditionally dark, anyone on a light-mode OS would have got the light half of every pair: a `bg-slate-200` progress track measures 14.5:1 against the slate-900 table — a near-white glare bar. One line of config fixed it.

## 🏆 Accomplishments We're Proud Of

**All three scenarios feasible, full workload, zero hard violations.** The mandatory gate is 100% workload delivery before any quality metric counts. We clear it on every scenario and re-prove it independently, on every run, with a validator that shares no code path with the solver that produced the schedule.

**Designing the ninth file to be optional — on purpose.** Judges will upload a hidden instance containing *the eight standard CSVs*. Our fleet feature needs a ninth. So `09_FLEET_DATA.csv` lives in a separate optional registry: the eight required files still gate Preview, an instance without a fleet solves exactly as it did before, and the new metrics return `null` rather than a fabricated `0` — the UI says "Upload 09_FLEET_DATA.csv" instead of showing a confident zero. **A judge's hidden instance cannot break this build.** That constraint shaped the architecture rather than being patched around at the end.

**Extra intelligence that can't cost us anything.** Working out how to make manpower optimisation and weather-awareness *optional, non-disruptive add-ons* — rather than changes to the scheduler — is the design decision we're happiest with. Both are off by default, neither touches the objective function, and the eight required CSVs alone still produce the same schedule they always did. We stopped treating "out of scope" as a reason not to build something and started treating it as a constraint on *how* to build it.

**We caught our own design flaw and turned it around.** Realising mid-hackathon that our planned UI would let an admin's experiment land on an engineer's roster was not a comfortable moment — the fix touched the whole admin flow, and the clock was not sympathetic. We scoped it down to what mattered, built the preview-and-compare rescheduling page, and shipped it. Spotting the problem was luck; being able to re-plan around it without losing the rest of the build was not.

**A metric we redesigned because the first version was noise.** "Closest team match?" originally benchmarked against the nearest crew of *any* specialty — which scored 20%, almost entirely from specialty mismatches rather than anything a planner could act on. Re-benchmarked against the nearest *eligible* crew, it reads 75.9%, and a `false` now means something specific and actionable: workload balancing moved this job. Same data, a question worth asking.

**A search that matches how a planner actually asks the question.** Nobody looks for "activity A017". They ask *what's happening on Line Alpha eastbound in March*, or *show me every P1 on contract C004*. So the three controls compose: a project-code search, an activity-priority filter, and a location filter that accepts whatever granularity you think in — a whole line, a directional track, a single station, or a specific sector id. They apply to every view at once, and ⌘K goes straight to it.

**Three ways to read the same schedule, because different people read it differently.** The timeline strip gives the whole horizon at a glance — bar height for possession density, colour for ECLO and overrun — and clicking a week jumps the list to it. The list view is the one an engineer scrolls before a shift. The month view is the one a controller uses to see a week's shape. Same filtered data, three lenses, no reload between them.

**Accessibility we measured instead of assumed.** The proximity bands are green/amber/red — the textbook colour-vision failure case. So we validated rather than eyeballed: the bar fills clear CVD separation at **ΔE 8.9 (protan)** against a threshold of 8, and all six pill text/fill pairs pass **WCAG AA** (8.3:1–10.4:1). Magnitude ends up triple-encoded — the number, the bar width, and the colour — so nothing depends on hue alone.

**56 tests, including the parts that usually go untested.** 27 backend tests covering geometry, matching, degenerate fleets and determinism; 29 frontend tests covering bearing maths, scale monotonicity, viewBox containment and distance banding. The visualisation maths is unit-tested, which is rare and is exactly how we caught three of the bugs above.

## 📚 What We Learnt

**Write the checker before you trust the solver.** Building `validation.py` as a genuinely independent re-check — not shared helpers with the solver — repeatedly caught modelling drift that a self-consistent solver would have happily reported as feasible. The discipline of "two implementations must agree" found more real bugs than any amount of reading the code.

**The specification's silences are design decisions in disguise.** The submission format can't express which two possessions at *different* locations fall on the same night. That's not a gap to paper over; it's a fork with real consequences for packing density. We documented our interpretation explicitly in the README, along with where to change it if the reference validator reads it differently. Naming your assumptions is cheaper than defending them later.

**Simulate the render, don't screenshot it.** Two of our sharpest bugs — the merged scatter dots and the inconsistent detour arithmetic — were invisible to the eye and obvious the moment we pushed all 54 real rows through the maths and asserted properties. Screenshots show you one state. Property tests show you all of them.

**Optional beats required when someone else brings the data.** Making the fleet file optional cost an afternoon of registry plumbing and bought complete immunity to whatever the judges upload. Designing for the input you *won't* control is a habit worth keeping.

## 🛣️ What's Next

**GIS-grade distance.** Today's distances are straight-line on the reconstructed network plane — honest, and enough to rank crews, but not a real journey time. The natural next step is a proper map layer: expertise-coded team pins, 30- and 60-minute travel-time isochrones around each depot, and genuine road routes via a Directions API, so "nearest crew" means nearest *by road at 1 AM* rather than nearest as the crow flies.

**Dynamic re-optimisation with minimal churn.** The bonus scope the problem statement names, and the one closest to the real 2 AM workflow: a location's quota drops from four nights to one, and the tool re-plans only what that actually touches — showing the controller a diff of what moved and why, rather than a wholly new schedule they have to re-audit from scratch.

**Natural-language querying.** "Why did A051 move?" and "what slips if I lose S04–H01 next week?" are the questions controllers actually ask. The view-model already pre-joins every schedule row with its contract and activity context, which is most of the retrieval problem solved.

**Production-hardening the deployment.** The run store is currently process memory, which pins the service to a single instance. Moving it to Firestore or GCS keyed by `run_id` unlocks horizontal scaling. The demo login is also client-side only — fine behind a judging URL, not an access control.

**Multiple access-nights per activity per week.** Our model gives each activity at most one night in any week, so a five-access activity spans at least five weeks. It's inherited from the greedy baseline and is the single largest driver of remaining overrun. If the specification permits several nights per week for one activity, relaxing it is the highest-value change left on the board.

---

*Built for the NebulaX Hackathon — Problem Statement 1.*
