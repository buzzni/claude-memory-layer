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
