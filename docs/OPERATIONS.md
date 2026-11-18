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
  sends the probe; its claim lasts as long as the call's CLI timeout plus a minute. Success closes the breaker; the same
  kind of failure reopens it and doubles the cooldown, up to 1 hour.
- **Fails open**: if the state cannot be read, locked or written, or holds times the clock cannot have produced, calls
  go to the provider as if there were no breaker.
- **Skipped session summaries are kept**, one file per session in `~/.claude-code/memory/summary-pending/` (session
  ids and times only). The semantic daemon retries them after the next summary call the provider answers. A kept
  summary does not disappear before its retry is done (the summary was stored, or there was nothing left to store);
  the only exceptions are the bounds: 7 days, 100 entries in the whole queue, 3 failed retries. A daemon that dies
  mid-retry leaves a claim the next retry takes back. An entry that cannot be read (permissions, I/O) is left alone;
  one that cannot be understood (corrupt, unknown version) is moved aside as `<name>.invalid-<time>` and removed after
  7 days.
  Lesson extraction needs no queue: it is computed on demand and failed groups are never cached, so the next
  `mem-lesson-candidates` call after recovery extracts them; until then its note names the open circuit and the next
  probe time.

State: `~/.claude-code/memory/llm-provider-breaker.json`. Check it with:

- `claude-memory-layer doctor`: the `llm-provider-breaker` check shows open circuits, the reason code, the next probe
  time and the number of kept summaries. `summary-provider` shows how many summary calls the daemon skipped.
- `claude-memory-layer audit`: the "LLM provider circuit" section, `llmProviderCircuit` in `--format json`.

Settings, including how to turn the breaker off, are in
[CONFIGURATION.md](CONFIGURATION.md#llm-summaries-and-lessons). To retry right away after logging in, delete
`llm-provider-breaker.json`; the next call then runs normally.

Known limits:

- When two processes take over a dead process's state lock at the same instant, both can get in, so the breaker may
  send one extra probe (one extra provider call) and two queue changes may overlap (#217).
- A summary skipped while the queue lock is unavailable for half a second is not kept; it stays eligible for the
  session-start backfill.

## What unattended work changes and what it does not

Hooks, the semantic daemon, background workers and the opt-in `maintenance` scheduler run with no one at the keyboard.
None of them deletes or rewrites the content of a stored event (prompt, response, tool observation, session summary)
or a lesson. What they remove is either derived data that is rebuilt from the events in SQLite, or bookkeeping that
holds no memory content. Deleting or rewriting stored memory takes an explicit command, or an explicit tool argument
from an agent.

The tables cover the paths that delete or change stored memory records (events, lessons, entities, actions, memory
assets, core blocks, actor cards, facets, perspective observations) and the vectors and queues built from them.
Access-control changes (`mem-asset-bind`, `mem-asset-grant-set`, shared actor links), telemetry, caches and
configuration are not listed.

"Recoverable" below means the data can be rebuilt from what is still stored. The governance audit is the
`memory_governance_audit` table in the project's `events.sqlite`; no command prints it yet. Its before and after
snapshots mask absolute paths and credential-looking values, so a version restored from one lacks those values.

### Unattended

| What runs | Started by | What it removes or changes | Recoverable | Audit |
|---|---|---|---|---|
| `maintenance run` | The launchd/systemd job from `maintenance install` (opt-in) | Requeues stuck vector jobs, embeds pending events, compacts LanceDB tables and drops table versions older than 1 hour (`CLAUDE_MEMORY_LANCE_VERSION_RETENTION_MS`) | Yes: vectors are rebuilt from SQLite | No; `maintenance status` shows the last run |
| Compaction after vector writes | Any process that writes vectors | After every 50 writes to a table (`CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY`), the same compaction and version cleanup | Yes | No |
| Embedding model change | An import that finds vectors from another model, including the Codex SessionEnd auto-import | Drops the legacy `conversations` vector table, empties the embedding queue and queues every event for embedding again. The per-version `event_vectors_*` tables are left in place. A store with vectors but no `embedding-meta.json` is first checked: if re-embedding a few stored vectors reproduces them, the file is written and nothing is dropped | Yes | No |
| Tool-observation vector auto-heal | SessionStart hook, in the background | Deletes vectors of `tool_observation` events embedded before those events were excluded from embedding, then compacts every vector table | Yes; the events stay | No |
| Embedding queue | Vector worker | Removes finished `embedding_outbox` jobs | Not memory | No |
| Graduation | Semantic daemon, background graduation worker | Raises an event's `memory_levels` entry (L0 → L1 …); never lowers one | The events are untouched | A run record in `build_runs` |
| Endless Mode consolidation | Consolidation worker, only while Endless Mode is enabled | Adds consolidated memories; prunes expired and over-limit `working_set` entries | The working set only lists event ids; the events stay | No |
| Kept session summaries (`summary-pending/`) | Semantic daemon | Entries past 7 days, beyond 100, or after 3 failed retries ([circuit breaker](#llm-provider-circuit-breaker)) | Entries hold session ids only; the session's events stay, without a summary unless the session-start backfill reaches it | Shown by `doctor` and `audit` |
| SessionEnd retry jobs (`session-end-pending/`) | Session-end worker | Jobs past 7 days, beyond 50, or after 3 failed retries | The session's stored events stay. While the transcript still exists and is readable, importing it restores prompts and responses, not hook-only rows or the rest of the SessionEnd work | `session-end-diagnostics.jsonl` |
| Event capture, session summaries, PreCompact checkpoints, Codex SessionEnd auto-import | Hooks and the semantic daemon | Add events and checkpoints and never change an existing event's content. SessionEnd also sets the session's `ended_at` | — | — |
| Session summary refresh ([session summaries](HOW_IT_WORKS.md#session-summaries)) | Semantic daemon | Hides the session's previous summary in the transaction that stores the newer one (`quarantine` metadata, category `superseded`); shows an earlier hidden summary again when the newer one repeats it word for word; records how much of the session a summary covers (`summarizedExchangeCount`, `summaryRefreshes`) on the summary itself | Yes: the hidden row, its text and vectors stay; clearing `quarantine.status` shows it again | Yes, a `quarantine` row per hidden or re-shown summary (no text) |
| Hook scratch files | Hooks | Transcript cursors idle for 14 days, pre-edit "already shown" markers older than 7 days, read snapshots left by exited processes, runtime telemetry files | Not memory | No |

### Agents (MCP tools, no human confirmation)

| Tool call | What it removes or changes | Recoverable | Audit |
|---|---|---|---|
| `mem-import-latest` with `force: true`; `mem-context-pack` with `refreshForce: true` when its freshness refresh runs (with `refreshLatest: true`, or automatically for a generic continuation query without a `sessionId` unless `refreshLatest: false`) | Force reimport of the most recent session of each source (`hermes` and `codex` by default, `claude` when asked), as the CLI `--force` below, under the tool's message limit (default 200, at most 1000). A session the limit could cut short is skipped, nothing deleted, and the result says why. Without `force`/`refreshForce` an import or refresh only adds events | **Partly**: the deleted rows come back from the transcript, with new event ids | Yes, a `session_reimport` row per session with deleted rows (actor `mcp`; session id, source, rows deleted; no text) |
| `mem-entity-supersede` | Marks the entity superseded and adds a `supersedes` edge | Yes; the entity stays | Yes |
| `mem-lesson-save` with an existing lesson's name | Replaces that lesson | From the audit's before snapshot | Yes |
| `mem-action-update` | Replaces an action's title, status, priority, source event ids, related entities, checkpoint or lease | From the audit's before snapshot | Yes |
| `mem-asset-update` | Replaces a memory asset's title, status, visibility, source refs or metadata (version checked) | From the audit's before snapshot | Yes |
| `mem-facet-tag` on an existing facet | Replaces its confidence and evidence event ids | From the audit's before snapshot | Yes |
| `mem-core-block-update`, `mem-actor-card-upsert` | Replace the block or the card | From the audit's before snapshot | Yes |
| `mem-perspective-observation-delete` | Sets `deleted_at` (soft delete) | Yes | Yes |

### Explicit commands

| Command | What it removes or changes | Recoverable | Audit |
|---|---|---|---|
| `forget --before <date> [--type <type>] --confirm` | Deletes the matching events, their vectors and dated mirror files, then runs VACUUM. Without `--confirm` it only previews | No | Yes, one `event_delete` row per run (actor `cli`; cutoff, type, the plan counted before the delete: matching rows and bytes and the number of mirror files to remove, not how many were removed; rows deleted; no text or event ids) |
| `forget <eventId>`, `forget --session <id>` | Nothing; not implemented (#211) | — | — |
| Dashboard `DELETE /api/events/:id` | Deletes one event and its vectors; the response names the event (id, type, time, session, content length), not its content | No | Yes, an `event_delete` row (actor `dashboard`; the same fields as the response, no text) |
| `import --force`, `codex import --force`, `hermes import --force` | Deletes the session's prompts and responses that earlier imports of the same transcript (Hermes: the same `state.db`) wrote, with their vectors and embedding jobs, then imports the transcript again and queues the rows it puts back for embedding. With `--limit`, a session the limit could cut short is skipped, nothing deleted, and the command exits 1. A session whose source has nothing to import again is skipped with a warning (exit 0). See the known limits below for what it keeps | **Partly**: the deleted rows come back from the transcript, with new event ids | Yes, a `session_reimport` row per session with deleted rows (actor `cli`; session id, source, rows deleted; no text) |
| `lesson add --apply`, `action update --apply`, `facet tag --apply` | The same changes as `mem-lesson-save`, `mem-action-update` and `mem-facet-tag` above | From the audit's before snapshot | Yes |
| `repair redact-credentials --apply` | Rewrites credential-looking text in events, helpfulness rows, retrieval traces and the Markdown mirror; deletes the affected vectors and requeues the events. What it could not finish is printed under `NOT FINISHED` and the command exits 1 ([below](#credential-redaction-runs-and-what-it-leaves-undone)) | No, by design | Yes, `credential_redact` rows that share a run id: one per committed batch of up to 100 rows (rows redacted per table and column, rows skipped, the batch's event ids) and a closing row with the run's totals and the mirror outcome; actor `cli`; no secret, text or preview |
| `repair legacy-project-scope --apply` | Adds repair or quarantine markers to event metadata; content is untouched | Yes | Markers in the metadata only |
| `vector compact --apply`, `repair prune-tool-observation-vectors --apply` | Compact vector tables; delete `tool_observation` vectors | Yes | No |
| `repair backfill-vectors --apply` | Only adds. For each event semantic search cannot reach: copies its vector from an unread `event_vectors_*` table when the current model made it and the event text is unchanged, otherwise queues the event for embedding | Yes: vectors are rebuilt from SQLite | No |
| `repair drop-spare-vectors --apply` | Drops the `event_vectors_*` tables, which search does not read. Refuses unless every event worth searching has a searchable vector or is waiting for the embedding worker, since until `repair backfill-vectors` such a table could hold an event's only vector | **No** | No |
| `repair supersede-session-summaries --apply` | In each session with two or more visible summaries, hides all but one the way a [summary refresh](HOW_IT_WORKS.md#session-summaries) does ([below](#older-sessions-with-more-than-one-summary)) | Yes: the hidden rows, their text and vectors stay; clearing `quarantine.status` shows one again | Yes, a `quarantine` row per hidden summary (no text) |
| `retention audit` | Nothing; reads a read-only snapshot | — | — |
| `retention apply-lifecycle` | Writes retention scores; deletes no events | Yes | Yes |
| `lesson consolidate --apply` | Adds a runbook and switches the lessons it absorbs off | Yes: `lesson revert-consolidation --apply` | Yes |
| `cleanup ephemeral --apply` | Stale runtime and adherence files | Not memory | No |
| `cleanup stores` | Nothing; preview only | — | — |
| `mongo-sync` (pull) | Only adds rows | — | — |

Known limits:

- **Force reimport replaces only rows it can put back** (#227). It deletes a row only when all of these hold: it is a
  prompt or a response, its `metadata.importedFrom` is the transcript (Hermes: the `state.db`) being imported again,
  it has no `metadata.mongoSync` marker, and no lesson lists it in `source_event_ids`. Everything else stays: rows the
  hooks and the daemon wrote (prompts, responses, session summaries, tool observations), rows another source or
  another path wrote, rows `mongo-sync` pulled, and lesson sources. The Claude hooks' prompts and responses that stay
  are not stored a second time: the append dedupe key and the SessionEnd reconcile recognize them. Before deleting, every
  importer checks that the source has something to import again (Claude: a record that parses; Codex: a message line
  that parses; Hermes: a user message), and the Codex importer still skips the delete when the Codex host wrote rows
  for the session. A message limit stops the reimport before the end of the session, so before deleting, the importer
  counts the most the session can count against the limit, with the import's own parsing and turn rules, and skips
  the session when that reaches the limit. Where the count depends on the store (duplicates, hook responses, turns
  the Codex host completed) it assumes the import counts, so it may skip a session that would have fit, never the
  other way round. Codex shares its limit across the selected sessions, so it adds them up and skips all of them.
  Limits: the rule reads `importedFrom` from metadata. Only the importers write it, but a row whose metadata names
  the same path is treated as imported, including a row pulled by `mongo-sync` before every pull was stamped, from
  a machine where the transcript had the same path. Such a row is deleted and imported again from the local
  transcript. A row imported from the same transcript under another path (a relative `--session` path, a moved
  transcript) is kept; the append dedupe key skips a new copy with the same content.
- **Re-created rows get new event ids** (#250). References to the deleted rows (helpfulness and usefulness
  observations, retrieval traces, working set, actions, facets, perspective observations, audit source ids and
  others) are not rewritten and point at missing events; their `memory_levels` entries, citations and embedding jobs
  (`embedding_outbox`, `vector_outbox`) are deleted with them. Their vectors are deleted from the legacy
  `conversations` table and every `event_vectors_*` table right after the rows; the rows put back are embedded again
  under their new ids, one vector each. If that vector delete fails, the reimport still succeeds and prints a warning,
  since the rows are already gone: the vectors left behind belong to no event. Semantic search of a project store
  goes through the retriever, which checks every vector hit against SQLite and drops them, asking for more hits in
  their place, so they cost vector search rounds and disk until removed. The vector index itself
  (`VectorStore.search`) still returns them. Vectors that force reimports before this change left behind stay too. Rows
  the reimport keeps keep their ids and vectors, so references to them stay valid.
- **Deletes are audited without their content** (#228). `forget --before`, the dashboard delete and force reimport
  write their audit row in the transaction that deletes the rows, so a delete never commits without it; a delete
  that removes nothing writes no row. The row records scope and counts, never the deleted text, so it shows when,
  by whom and how much was deleted, not what. `repair redact-credentials --apply` writes each batch's
  `credential_redact` row in the transaction that rewrites that batch's rows; a dry run writes none.

## Credential redaction runs and what it leaves undone

`repair redact-credentials --apply` works in this order:

1. It scans SQLite without taking the write lock. Every 100 values that need redacting are written as one batch: a
   short transaction with the batch's updates, the removal of the changed events' queued embedding jobs (they carry
   their own copy of the old text) and the batch's audit row. The write lock is held one batch at a time, never for
   the scan. Measured on one machine with every value changing, the longest write transaction of a run (batch,
   re-queue or closing row) was about 15 to 115 ms: 100 values of 4 to 14 KB each, with up to 115,000 jobs already in
   the embedding queue, against the hooks' 5 s busy timeout. That is a measurement, not a guarantee for every store
   and machine. The output prints the longest committed batch of the run.
2. Right after a batch commits, it deletes the old vectors of the batch's events and queues them for re-embedding.
3. It rewrites the Markdown mirror files, whatever happened in SQLite.
4. It writes a closing audit row with the run's totals and the mirror outcome.

Each SQLite update applies only while the value still matches what the scan read. A value a hook or another command
changed in between is left as it is, never overwritten with the redacted form of its old text. Batches that
committed stay committed whatever happens later. When a run cannot finish, it says so under `NOT FINISHED` and
exits 1:

| What happened | What is left | What to do |
|---|---|---|
| Values changed or deleted after the scan read them | The changed values, which may still hold a credential | Run `--apply` again; the next run redacts them |
| A batch failed (an update, the removal of its queued embedding jobs, or its audit row could not be written) | The batch is retried one value at a time, so only the values that still fail keep their text (and their queued jobs), with no audit row | Run `--apply` again once the cause is fixed |
| SQLite stayed busy past the busy timeout, in a batch or in a re-queue | The values the run had not reached, and in a re-queue that batch's events without a queued job. The SQLite pass stops; the mirror is still rewritten | Run `--apply` again; `repair backfill-vectors --apply` for events left without a vector |
| A mirror file could not be rewritten | That file, unchanged; the run carries on | Fix the file's permissions, then run `--apply` again |
| An old vector could not be deleted | That vector, which may hold the credential. The event is redacted, so a re-run does not retry the delete | No command retries it yet. The run lists the events in `redact-credentials-<runId>-vector-delete-failures.txt` in the project store (readable by you only) and prints its path. An event id that looks like it holds a credential is listed as `events rowid <n>` instead; read it with `SELECT id FROM events WHERE rowid = <n>` before the next VACUUM (`forget` runs one) |
| Queuing for re-embedding failed | The batch's redacted events with no queued job: the old jobs went with the update. Their old vectors may or may not have been deleted | `repair backfill-vectors --apply` queues events that have no vector |
| The closing audit row could not be written | The batch rows; the totals and mirror counts are only in the output | — |

Row ids in the output (dry run and apply), in the failure file and in the audit rows' `source_event_ids` are the ids
themselves, except an id that looks like it holds a credential, which imported events can have: it is given as
`<table> rowid <n>` instead.

Reading the audit: every `credential_redact` row of one run has the same `runId` in `after_json`; batch rows carry
`batch`, the closing row `summary: true`. Batch rows without a closing row mean the run did not finish. A closing
row does not mean it succeeded: check its `rowsFailed`, `rowsSkipped`, `stoppedBusy`, `mirrorFilesFailed`,
`vectorDeleteFailures` and `requeueFailures`.

Known limits:

- A run that is interrupted (killed, or the machine stops) loses the batch it was building: up to 99 values it had
  already scanned stay unredacted, where committing every value on its own would have kept them. Nothing is printed
  in that case, and a re-run picks the values up.
- A value is redacted only together with the removal of its event's queued embedding jobs and with its audit row,
  in one transaction. If either of those cannot be written, the value keeps its text (with a retry per value), where
  a commit per value without them would have redacted it. That is the price of never committing a redaction without
  its audit row, and never leaving a queued job with the old text behind a redacted event.
- A run interrupted before its first batch committed leaves no audit row, and neither does one interrupted while
  only the mirror had changed, since the mirror is recorded in the closing row. The audit cannot show such runs.
- An embedding worker that took a job before the run removed it can still write a vector of the old text after the
  run deleted the event's vectors. The command has always had this race; nothing in the run detects it.
- A mirror directory or file that cannot be read is skipped without a message, as before: it is neither counted nor
  reported, so a run can finish with exit 0 while such a file still holds a credential.

## Older sessions with more than one summary

Sessions summarized before the summary refresh can hold two or more visible summaries, so search, injection and
context packs return several summaries of one session (#254). The refresh hides only the summaries it replaces, so these
sessions stay as they are. After upgrading, run this once per project store:

```bash
claude-memory-layer repair supersede-session-summaries --project /path/to/project          # preview
claude-memory-layer repair supersede-session-summaries --project /path/to/project --apply  # hide the others
```

- **Which summary stays**: the newest summary written by the LLM (`metadata.generated: "llm"`), else the newest. Some
  older sessions hold an LLM summary next to a later template summary (`Session with N user prompts…`); the LLM
  summary stays and the template is hidden. Only the newest LLM summary of a session stays: older LLM summaries of the
  same session are hidden too, without comparing what they say, so anything only an older one recorded is no longer
  returned. On a tie in time, the row stored last stays.
- **The preview writes nothing**: without `--apply` the command reads a temporary copy of the store, as the read-only
  diagnostics do, so the store and its `-wal`/`-shm` files are not created or touched. The copy is not a consistent
  point-in-time read: a checkpoint during the copy can make the preview a little stale or, rarely, fail (run it again).
  `--apply` decides again from the store itself.
- **Symlinks**: a project path that is a symlink is resolved first, so it reaches the same store as its target. A store
  reached through a symlink in the store path itself (the memory root `~/.claude-code/memory`, `projects/`, the project
  directory or `events.sqlite`) cannot be previewed: the copy refuses it, as for the read-only diagnostics, and the
  command fails with `SQLITE_SNAPSHOT_UNSAFE_SOURCE` and changes nothing. `--apply` opens the store through the link
  and changes it without a preview, so back up the project directory first.
- **How they are hidden**: as the refresh does, with `quarantine` metadata in category `superseded` and a governance
  audit row each. Nothing is deleted. The preview prints the number of sessions and summaries and how many of each kind
  (`metadata.generated`, `unlabeled` when absent) it keeps and hides.
- **All or nothing**: `--apply` takes the store's write lock first and waits up to 5 seconds for a hook that is
  writing. If it still fails, nothing has changed; run it again. A second run finds nothing to hide.
- **Afterwards**: a refresh treats the kept summary as the session's current one. When an older LLM summary is kept
  over a later template summary, it covers fewer prompts and answers, so the session can become due for a refresh when
  its next turn ends (one LLM call). A refresh whose text repeats a hidden summary shows that summary again in place of
  the kept one, as for any summary a refresh hid.
- **Other machines**: summaries already pushed by `mongo-sync` stay visible on the other machines until the command
  runs there too.
