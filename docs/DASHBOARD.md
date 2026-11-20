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
- Answers only requests whose `Host` header names `localhost`, `127.0.0.1` or `[::1]` on the serving port, which blocks DNS-rebinding pages. Every other `Host` gets an empty `403` on every route, including `/health`. To reach the dashboard by another name or address (a `0.0.0.0` bind over the LAN, or a reverse proxy that forwards the public `Host`), list it in `DASHBOARD_ALLOWED_HOSTS` (comma-separated; `hostname` for any port, `hostname:port` for one), e.g. `DASHBOARD_ALLOWED_HOSTS=192.168.0.10:37777,memory.example.com`.
- The password is optional (`--password`, or `DASHBOARD_PASSWORD` / `CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD`). **Without a password the API has no authentication**: anything that can reach the port and send an allowed `Host` can read stored memory. Always set a password when binding to `0.0.0.0`.
- Cross-origin reads are blocked unless the origin is listed in `DASHBOARD_ALLOWED_ORIGINS` (comma-separated). State-changing API requests are rejected unless their `Origin` names an allowed host or is listed in `DASHBOARD_ALLOWED_ORIGINS`.

Details (Host matching rules, cookie settings, Origin checks): [SECURITY.md](../SECURITY.md).

## Health endpoints

- `GET /health`: server health
- `GET /api/health`: detailed health including outbox pending/failed
- `GET /api/stats/retrieval-traces`: search → context adoption traces

With a password set, everything except `/health` and `/api/auth/*` requires login.

Dashboard chat passes your question and recalled memories to the local `claude` CLI, which sends them to its provider.

## Turn endpoints

- `GET /api/turns?sessionId=<session>`: the session's turns, each with only that session's events. `sessionId` is required (`400` without it).
- `GET /api/turns/<turnId>?sessionId=<session>`: one turn's prompt, tool calls and responses (`turnId`, `sessionId`, `startedAt`, `prompt`, `tools`, `responses`, `totalEvents`). `404` when that session holds no event with this turn id.

A turn id is not unique across sessions: a forked or re-imported Codex transcript keeps the host's turn ids under a new session id. Pass `sessionId` with the turn id you got from the session's turn list. Without it, a turn id held by more than one session is not merged; it answers `409`:

```json
{ "error": "Turn id is shared by more than one session; pass sessionId", "sessionIds": ["<session-a>", "<session-b>"] }
```

Retry with one of the listed `sessionIds`. A turn id that only one session holds still answers `200` without `sessionId`.
