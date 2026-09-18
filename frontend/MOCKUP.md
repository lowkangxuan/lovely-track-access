# Schedule UI mockup

Run `npm run dev` in `frontend`, then visit `/mockup` (no backend or login needed).
The normal `/` route retains the existing application.

The preview reuses the existing timeline, possession cards, metric tiles and
activity detail modal. It adds project-code search, contract-priority and occupied-location
filters, a schematic station picker, a monthly grid and a scenario KDA dialog.
Filters persist between views; the summary and KDA represent the full scenario.
Project codes map to contract numbers. KDA provisionally uses the existing §2.5
scenario rubric: feasibility, priority-weighted overrun, excess nights and ECLO.

Calendar entries use the backend's week-start dates, not assigned nightly dates.
The three scenarios and CSV downloads use bundled-data snapshots. Rescheduling
links back to the live application. To refresh the snapshots from the solver:

```sh
backend/.venv/bin/python frontend/scripts/generate-mockup.py
```

Verified in-browser: project search, combined filters and empty state, clearing
filters, list/month switching, calendar overflow details, scenario B KDA, and
station selection. `npm run build` passes.
