#!/usr/bin/env python3
"""Read-only, content-free local CML audit. Prints aggregate JSON; never opens CML runtime."""
import argparse
import collections
import datetime as dt
import json
import pathlib
import sqlite3

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--root', type=pathlib.Path, default=pathlib.Path.home() / '.claude-code/memory')
p.add_argument('--until', default=dt.datetime.now(dt.timezone.utc).isoformat())
a = p.parse_args()
end = dt.datetime.fromisoformat(a.until.replace('Z', '+00:00'))
if end.tzinfo is None:
    p.error('--until must include a timezone')
start = end - dt.timedelta(hours=48)
mid = end - dt.timedelta(hours=24)
args = (start.isoformat(), end.isoformat())
window = 'julianday({}) >= julianday(?) AND julianday({}) < julianday(?)'
def within(column):
    return window.format(column, column)
def rows(c, sql, params=()):
    return [dict(r) for r in c.execute(sql, params)]

report = {'since': start.isoformat(), 'until': end.isoformat(), 'stores_scanned': 0,
          'errors': [], 'active': [], 'inactive': 0}
paths = sorted(a.root.glob('projects/*/events.sqlite'))
if (a.root / 'events.sqlite').exists():
    paths.append(a.root / 'events.sqlite')
for index, path in enumerate(paths):
    label = 'global' if path.parent == a.root else 'store-%03d' % index
    try:
        c = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA query_only=ON')
        c.execute('BEGIN')
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        report['stores_scanned'] += 1
        if 'events' not in tables:
            report['inactive'] += 1
            c.close()
            continue
        ev = rows(c, 'SELECT count(*) n,count(distinct session_id) sessions, '
                  'coalesce(sum(length(content)),0) chars FROM events WHERE '+within('timestamp'), args)[0]
        tr = rows(c, 'SELECT count(*) n FROM retrieval_traces WHERE '+within('created_at'), args)[0]['n'] if 'retrieval_traces' in tables else 0
        if not ev['n'] and not tr:
            report['inactive'] += 1
            c.close()
            continue
        d = {'store': label, 'events48': ev, 'traces48': tr}
        # Preserve only a coarse diagnostic hint. Even a basename can disclose
        # a private project name when this aggregate is committed publicly.
        projects = rows(c, 'SELECT project_path,count(*) n FROM sessions GROUP BY project_path ORDER BY n DESC LIMIT 3')
        test_name = ('test', 'testing', 'fixture', 'scratch', 'sandbox', 'playground', 'tmp', 'temp')
        d['projects'] = [{
            'path_hint': ('unknown' if not r['project_path'] else
                          'test-looking' if any(token in pathlib.Path(r['project_path']).name.lower() for token in test_name)
                          else 'other'),
            'sessions_all': r['n']
        } for r in projects]
        d['event_days'] = rows(c, 'SELECT CASE WHEN julianday(timestamp)<julianday(?) THEN \'previous24\' ELSE \'last24\' END period,count(*) n FROM events WHERE '+within('timestamp')+' GROUP BY period', (mid.isoformat(), *args))
        d['event_types'] = rows(c, 'SELECT event_type,count(*) n FROM events WHERE '+within('timestamp')+' GROUP BY event_type', args)
        source_sql = "CASE WHEN json_extract(metadata,'$.source') IN ('codex','hermes','claude','native') THEN json_extract(metadata,'$.source') ELSE 'native_or_unknown' END"
        d['sources'] = rows(c, 'SELECT '+source_sql+' source,count(*) n FROM events WHERE '+within('timestamp')+' GROUP BY source', args)
        d['exact_duplicate_excess'] = rows(c, 'SELECT coalesce(sum(n-1),0) n FROM (SELECT count(*) n FROM events WHERE '+within('timestamp')+' GROUP BY event_type,content HAVING count(*)>1)', args)[0]['n']
        d['event_total'] = c.execute('SELECT count(*) FROM events').fetchone()[0]
        if tr:
            cols = {r[1] for r in c.execute('PRAGMA table_info(retrieval_traces)')}
            dims = [x for x in ['trigger_type','presentation_mode','delivery_client','outcome_reason'] if x in cols]
            d['trace_dimensions'] = {x: rows(c, 'SELECT '+x+' value,count(*) n FROM retrieval_traces WHERE '+within('created_at')+' GROUP BY '+x, args) for x in dims}
            d['trace_counts'] = rows(c, 'SELECT sum(candidate_count) candidates,sum(selected_count) selected,sum(selected_count=0) empty FROM retrieval_traces WHERE '+within('created_at'), args)[0]
            ids = collections.Counter()
            for r in c.execute('SELECT selected_event_ids FROM retrieval_traces WHERE '+within('created_at'), args):
                ids.update(json.loads(r[0] or '[]'))
            ages = collections.Counter()
            selected_sources = collections.Counter()
            lessons = {r[0] for r in c.execute('SELECT lesson_id FROM memory_lessons')} if 'memory_lessons' in tables else set()
            for eid, n in ids.items():
                r = c.execute('SELECT timestamp,event_type,'+source_sql+' source FROM events WHERE id=?', (eid,)).fetchone()
                if r is None:
                    ages['lesson_reference' if eid in lessons else 'unresolved_reference'] += n
                else:
                    ts = dt.datetime.fromisoformat(r['timestamp'].replace('Z','+00:00'))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=dt.timezone.utc)
                    age = (end-ts).total_seconds()/86400
                    ages['under2d' if age <= 2 else '2to7d' if age <= 7 else 'over7d'] += n
                    selected_sources[r['source']] += n
            d['selection'] = {'unique_events': len(ids), 'occurrences': sum(ids.values()), 'top5_occurrences': sum(n for _, n in ids.most_common(5)), 'age_at_window_end': dict(ages), 'sources': dict(selected_sources)}
        for table in ['memory_helpfulness','memory_lessons','consolidated_memories']:
            if table in tables:
                d[table] = rows(c, 'SELECT count(*) n FROM '+table+' WHERE '+within('created_at'), args)[0]['n']
        if 'memory_helpfulness' in tables:
            d['helpfulness'] = rows(c, 'SELECT count(*) n,sum(measured_at IS NOT NULL) measured,avg(helpfulness_score) avg_score FROM memory_helpfulness WHERE '+within('created_at'),args)[0]
        if 'memory_usefulness_observations_v2' in tables and 'retrieval_traces' in tables:
            d['usefulness_v2'] = rows(c, 'SELECT o.evaluator_version,o.adoption,o.delivered,o.task_outcome,count(*) n FROM memory_usefulness_observations_v2 o JOIN retrieval_traces t ON t.trace_id=o.trace_id WHERE '+within('t.created_at')+' GROUP BY 1,2,3,4',args)
        if 'embedding_outbox' in tables:
            d['embedding_status_all'] = rows(c, 'SELECT status,count(*) n FROM embedding_outbox GROUP BY status')
        report['active'].append(d)
        c.close()
    except (sqlite3.Error, ValueError, TypeError) as exc:
        report['errors'].append({'store': label, 'error_type': type(exc).__name__})
        if 'c' in locals():
            c.close()
print(json.dumps(report, ensure_ascii=False, indent=2))
