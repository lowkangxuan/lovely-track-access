"""Refresh the offline preview: backend/.venv/bin/python frontend/scripts/generate-mockup.py"""
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'backend'))
from main import default_schedule

fixtures = {}
for scenario in 'ABC':
    data = default_schedule(scenario)
    for field in ('run_id', 'detail', 'contracts', 'elapsed_ms'):
        data.pop(field, None)
    templates = {}
    rows = []
    for task in data['tasks']:
        aid = task['activity_id']
        template = templates.setdefault(aid, task)
        rows.append({'activity_id': aid, **{k: v for k, v in task.items() if template[k] != v}})
    data['task_templates'] = templates
    data['tasks'] = rows
    fixtures[scenario] = data
(root / 'frontend/src/mockup-data.json').write_text(json.dumps(fixtures, separators=(',', ':')) + '\n')
print('Updated offline scenario snapshots.')
