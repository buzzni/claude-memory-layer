# Operations Runbook

## Health scripts

- `npm run ops:sync-gap:report`
- `npm run ops:sync-gap:fix`
- `npm run ops:sync-gap:heal`
- `npm run ops:review:resolve`
- `npm run ops:heartbeat`

## Status policy

- `ok`: no failed outbox items and no un-leveled events after heal
- `needs-attention`: failed outbox remains or level sync still broken

## Notes

These scripts are best-effort operational automation for Claude memory DB (`~/.claude-code/memory/events.sqlite`).

## Dashboard network access

The dashboard answers a request only when its `Host` header names an allowed host. This blocks DNS-rebinding pages
that resolve an attacker's domain to `127.0.0.1`. Rejected requests get an empty `403` on every route, including
`/health`. A syntactically invalid `Host` (spaces, `@`, …) or an HTTP/1.1 request without `Host` is answered with
`400` by Node's HTTP server or the adapter before the allow-list runs.

- **Default:** `localhost`, `127.0.0.1` and `[::1]` on the serving port (for example `localhost:37777`). Case and a
  single trailing dot are ignored. A `Host` without a port counts as port 80. A request with no `Host` is rejected.
- **Other names or addresses** (a `0.0.0.0` bind reached over the LAN, or a reverse proxy that forwards the public
  `Host`): set `DASHBOARD_ALLOWED_HOSTS` to a comma-separated list. `hostname` allows any port and `hostname:port`
  allows only that port, e.g. `DASHBOARD_ALLOWED_HOSTS=192.168.0.10:37777,memory.example.com`. Entries are host names,
  not origins: `http://…` entries are ignored. Programmatic callers can pass `allowedHosts` to `startServer` or
  `createDashboardApp` instead.
- A `0.0.0.0` bind without `DASHBOARD_ALLOWED_HOSTS` prints a startup warning. It still answers the loopback names only.
- State-changing `/api/*` requests that carry an `Origin` must name an allowed host (`http` or `https`) or be listed
  in `DASHBOARD_ALLOWED_ORIGINS`. The `Origin` is not compared with the request's own `Host` header.
- Check from a shell: `curl -i -H 'Host: evil.example:37777' http://127.0.0.1:37777/health` returns `403` with an
  empty body; `curl -i http://127.0.0.1:37777/health` returns `200`.

## Lesson usage and lookup diagnostics

The inspection steps below are read-only. The optional restart is a separate, deliberate user action.

1. **Installed CLI version** — `claude-memory-layer --version`. A long-running MCP server keeps the code it started
   with. The audit's `runtimeVersions` (step 3) describe retrieval-trace writers, not the running MCP process;
   verify that process's installed artifact independently before deciding it needs a restart.
2. **Same-store view** — `claude-memory-layer stats -p <project>` and an MCP `mem-lesson-list` / `mem-lesson-get` for
   the same `projectPath` must describe the same store. MCP list/get each read one validated snapshot and do not create a missing
   store (`store_missing`), and an old schema without a required lesson column returns `schema_incompatible`.
   `snapshot_inconsistent` is retryable (a writer raced the copy); the read is retried once internally first.
   `snapshot_unavailable` points to temporary storage, while `source_unreadable` points to the source store's access.
   Older stores without the asset table remain unregistered: with a requester, `registered` permits access and
   `strict` excludes them. Reads do not create the table or remove existing permission checks.
   The copied snapshot is best effort: a checkpoint that runs during the copy can also produce a valid but stale
   view, which is not detected or retried. If a just-written lesson or event is missing, repeat the read; there is
   no consistency or latency guarantee.
3. **Audit** — `claude-memory-layer audit --since <iso> --until <iso> --format json` (window is `[since, until)` on the
   stored-at clock). Read per store:
   - `promptQuality`: stored `user_prompt` rows split by classifier v1 (automated notifications, host scaffolding,
     requests left after normalization). Overlapping counts — never sum them. Older rows are classified on read, not
     rewritten.
   - `lessonUsage`: `selection` (hook/SessionStart listings; a reference listing is not a delivered body),
     `host` selected/delivered/read traces with `deliveryLineage` (exact / legacy unique / ambiguous / unlinked),
     and `mcpBodyLookups` (Claude tool observations only; Codex/Hermes are *unobserved*, not zero). These are separate
     provenances and are not summed into a read or adoption rate. `applied`/`taskSuccess` stay `unknown`.
   - `lessonQuality`: `active` means `recall_enabled` only (`activeBasis`), not that a lesson passes scope,
     permission, or version gates. Evidence refs are `no refs` / `local refs found` / `refs unresolved here`. Missing evidence is not
     a verdict on the lesson; nothing is disabled or deleted.
   - `sources`: source clocks vs stored-at clocks. A quiet period can simply mean no activity; it is not a backlog.
4. **Restart only if needed** — if the running MCP process uses an older installed artifact than step 1,
   the user restarts it (for example by restarting the client session). Retrieval-trace versions alone do not establish this.
5. **Re-run the same read** — repeat the step 2 read for the same project and compare.

## LLM provider circuit breaker

Session summaries and lesson extraction call a local `claude` (or `codex`) CLI. When that CLI is logged out or has hit a
usage/rate limit, every call fails the same way until someone logs in or the quota resets. A per-provider circuit
breaker stops paying for those calls:

- **Opens** after 3 consecutive `provider-auth` or `provider-rate-limit` failures. Timeouts and other errors neither
  count nor reset the streak, so a single slow call never opens it.
- **While open**, calls are skipped without starting the CLI (`provider-circuit-open`).
- **Probes** once after a 5-minute cooldown. Concurrent hook and daemon processes share the state, and only one of them
  sends the probe. Success closes the breaker; the same kind of failure reopens it and doubles the cooldown, up to 1 hour.
- **Skipped session summaries are kept** in `~/.claude-code/memory/summary-pending.json` (session ids and times only,
  at most 100 entries, 7 days). The semantic daemon summarizes them after the next summary call the provider answers.
  Lesson extraction needs no queue: it is computed on demand and failed groups are never cached, so the next
  `mem-lesson-candidates` call after recovery extracts them.

State: `~/.claude-code/memory/llm-provider-breaker.json`. Check it with:

- `claude-memory-layer doctor`: the `llm-provider-breaker` check shows open circuits, the reason code, the next probe
  time and the number of kept summaries. `summary-provider` shows how many summary calls the daemon skipped.
- `claude-memory-layer audit`: the "LLM provider circuit" section, `llmProviderCircuit` in `--format json`.

Settings (environment, like the other `CLAUDE_MEMORY_*` LLM settings; set them in `settings.json` `env` so hook-spawned
daemons see them):

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEMORY_LLM_BREAKER` | on | `off` disables the breaker |
| `CLAUDE_MEMORY_LLM_BREAKER_THRESHOLD` | `3` | consecutive auth/limit failures that open it |
| `CLAUDE_MEMORY_LLM_BREAKER_COOLDOWN_MS` | `300000` | wait before the first probe |
| `CLAUDE_MEMORY_LLM_BREAKER_MAX_COOLDOWN_MS` | `3600000` | cap for the doubling cooldown |

To retry right away after logging in, delete `llm-provider-breaker.json`; the next call then runs normally.
