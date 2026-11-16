# Dashboard

[← README](../README.md)

A local web dashboard for browsing and checking memory.

```bash
claude-memory-layer dashboard            # opens http://localhost:37777
claude-memory-layer dashboard --no-open
claude-memory-layer dashboard --bind localhost --port 37777 --password "<local-password>" --no-open
```

| Option | Default | Meaning |
|---|---|---|
| `-p, --port <port>` | `37777` | Server port |
| `--bind <host>` (alias `--host`) | `localhost` | `localhost` or `0.0.0.0` |
| `--password <password>` | none | Require this password before serving the dashboard |
| `--no-open` | | Do not open a browser |

## What it shows

- Live event stream and browsing by session and project
- Vector and keyword search, store statistics
- Retrieval traces: query → candidate/adopted counts → final context ids, score breakdown (semantic/lexical/recency), lane debug
- Vector health: embedding/vector queue pending, processing, failed and stuck counts, vector count, recovery results
- Perspective memory: actor/session membership, observer→observed graph, actor-card counts, observation/contradiction/source-evidence aggregates
- API errors and output are rendered mostly as aggregates and avoid exposing raw paths, item ids, error payloads and memory content.

## Security

- Binds to localhost by default. `0.0.0.0` must be chosen explicitly.
- The password is optional (`--password`, or `DASHBOARD_PASSWORD` / `CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD`). **Without a password the API has no authentication**: anything that can reach the port can read stored memory. Always set a password when binding to `0.0.0.0`.
- Cross-origin reads are blocked unless the origin is listed in `DASHBOARD_ALLOWED_ORIGINS` (comma-separated), and state-changing API requests from another origin are rejected.

Details (cookie settings, Origin checks): [SECURITY.md](../SECURITY.md).

## Health endpoints

- `GET /health`: server health
- `GET /api/health`: detailed health including outbox pending/failed
- `GET /api/stats/retrieval-traces`: search → context adoption traces

With a password set, everything except `/health` and `/api/auth/*` requires login.

Dashboard chat passes your question and recalled memories to the local `claude` CLI, which sends them to its provider.
