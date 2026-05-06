# Product Validation Matrix

This document mirrors the tested matrix in `src/core/product-validation-matrix.ts`. The matrix is data-first so product reports and future CLI/API surfaces can reuse the same surface → requirement → evidence representation.

## Scope

| Area | Surface | Status | Validation intent |
| --- | --- | --- | --- |
| Claude | Claude adapter import | covered | Import Claude Code JSONL while filtering tool/local-command noise and preserving turn/project continuity. |
| Claude | Claude adapter search | covered | Search memory by project/session with plain and disclosure output paths. |
| Claude | Claude adapter disclosure | covered | Exercise search → expand → source/citation disclosure flow. |
| Codex | Codex adapter scan | ready | Recursively scan `~/.codex/sessions`, match by `session_meta.payload.cwd`, and count malformed/unsupported records. |
| Codex | Codex adapter import | covered | Existing explicit import path remains mutation-only; `codex import` now exposes project/session/all imports while validation/replay stay read-only. |
| Codex | Codex adapter replay | ready | Normalize real Codex `response_item` message records and aggregate replay counts without transcript content. |
| Hermes | Hermes adapter scan | ready | Read Hermes `~/.hermes/state.db` in read-only mode, match project context, and aggregate unsupported/empty/truncated counts without transcript content. |
| Hermes | Hermes adapter import | covered | `hermes import` exposes project/session/all imports while preserving SessionDB as raw source-of-truth and storing only redacted user/assistant turns. |
| Hermes | Hermes adapter replay | ready | Normalize Hermes SessionDB rows into aggregate replay reports without transcript content or secrets. |
| MCP | MCP context pack | covered | Combine relevant project memories and recent timeline into agent-ready startup context with citations/follow-up refs. |
| MCP | MCP project timeline | covered | Summarize recent project memory by session, source agent, event counts, and safe preview. |
| MCP | MCP source reference | covered | Resolve event/mem citation refs into redacted source previews with safe metadata only. |
| CLI/API | CLI / API / reporting | ready | Provide `claude-memory-layer codex validate` / `codex replay` and `hermes validate` / `hermes replay` with JSON/Markdown reports. |
| Safety | Safety / dry-run | ready | Default Codex/Hermes validation is read-only, avoids Claude settings/memory mutation, and can exclude transcript content from reports. |

## Codex validation requirements

`claude-memory-layer codex validate` and `claude-memory-layer codex replay` are intentionally read-only. They support:

- `--project <path>`: match sessions whose `session_meta.payload.cwd` resolves to the project path.
- `--sessions-dir <path>`: override the default `~/.codex/sessions` root.
- `--limit <number>`: cap the number of session files scanned.
- `--format json|markdown`: choose machine-readable or human-readable aggregate output.
- `--output <path>`: save the aggregate report to disk.
- `--dry-run`: explicit safety marker; mutation is not supported by validation/replay.
- `--anonymize-projects`: replace raw cwd labels with stable project hashes for shareable reports.

Reports include only aggregate counts: sessions scanned/matched, records read, messages/turns normalized, user/assistant counts, malformed lines, skipped/unsupported records, empty assistant messages, truncated messages, missing cwd, warnings, top projects, and source paths. Transcript text is never included in validation reports.

## Hermes validation requirements

`claude-memory-layer hermes validate` and `claude-memory-layer hermes replay` are intentionally read-only. They support:

- `--project <path>`: match sessions whose Hermes session context/title includes the project path.
- `--state-db <path>`: override the default `~/.hermes/state.db` source for tests, profiles, or replay fixtures.
- `--limit <number>`: cap the number of matching sessions scanned.
- `--format json|markdown`: choose machine-readable or human-readable aggregate output.
- `--output <path>`: save the aggregate report to disk.
- `--dry-run`: explicit safety marker; mutation is not supported by validation/replay.

Reports include only aggregate counts: sessions scanned/matched, messages read/normalized, turns normalized, user/assistant counts, skipped/unsupported messages, empty assistant messages, truncated messages, missing project context, warnings, top sources, and source paths. Transcript text is never included in validation reports.

## MCP context navigator requirements

The MCP server exposes read-only project context navigation for Claude Desktop, Codex, Hermes, and other MCP clients. These tools support the same optional `projectPath` scoping as `mem-search`/`mem-stats`:

- `mem-context-pack`: agent startup context pack. It combines relevant retrieval results (`query`, `topK`, optional `sessionId`) with a bounded recent project timeline (`recentLimit`, `sessionLimit`) and returns follow-up citation refs.
- `mem-project-timeline`: recent project memory grouped by session, source agent/import source, event counts, and a privacy-filtered last preview.
- `mem-source-ref`: resolves `event:<id>`, full event IDs, `mem:<citation>`, bare citation IDs, or `[mem:<citation>]` into source metadata and a redacted preview.

The tools are intentionally context/navigation-oriented rather than mutation APIs. `mem-source-ref` uses a narrow safe metadata allowlist and shared privacy filtering before returning previews; raw transcript dumps should use lower-level detail APIs only when explicitly needed.

## Codex import requirements

`claude-memory-layer codex import` is the explicit mutation path. It supports:

- `--project <path>`: import matching Codex sessions into the project-scoped memory store.
- `--session <file>`: import one Codex JSONL session into the selected project scope.
- `--all`: import all Codex sessions; without `--project`, this intentionally uses global memory and prints a warning.
- `--sessions-dir <path>`: override the default `~/.codex/sessions` root for tests, replays, or alternate Codex profiles.
- `--limit <number>`, `--force`, `--verbose`, and `--no-process-embeddings` for bounded/repeatable operational runs.

## Evidence

- `tests/core/product-validation-matrix.test.ts` checks coverage, summary, and Markdown rendering of the matrix.
- `tests/core/codex-session-history-importer-validation.test.ts` covers Codex dry-run scan/replay, cwd project matching, malformed lines, unsupported/tool-ish records, empty assistant messages, large/truncated content, missing cwd, all-session summary, and transcript exclusion.
- `tests/apps/codex-validation-output.test.ts` covers JSON and Markdown reporting helpers.
- `tests/apps/codex-import-runner.test.ts` covers explicit Codex import routing for project, session, and global all-session modes.
- `tests/extensions/mcp-context-tools.test.ts` covers MCP context-pack/timeline/source-ref routing, output shape, citation refs, safe previews, and secret redaction.
- `src/extensions/mcp/tools.ts` defines MCP schemas for search/timeline/details/stats and the context navigator tools.
- `src/extensions/mcp/handlers.ts` implements project-aware MCP tool dispatch and privacy-safe context navigation formatting.
- `src/services/codex-session-history-importer.ts` implements read-only scan/normalize/validate helpers in addition to existing explicit Codex import APIs.
- `src/apps/cli/codex-import-runner.ts` implements the safe import command runner.
- `src/apps/cli/index.ts` exposes the user-facing commands.
