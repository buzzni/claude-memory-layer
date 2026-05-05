# Product Validation Matrix

This document mirrors the tested matrix in `src/core/product-validation-matrix.ts`. The matrix is data-first so product reports and future CLI/API surfaces can reuse the same surface → requirement → evidence representation.

## Scope

| Area | Surface | Status | Validation intent |
| --- | --- | --- | --- |
| Claude | Claude adapter import | covered | Import Claude Code JSONL while filtering tool/local-command noise and preserving turn/project continuity. |
| Claude | Claude adapter search | covered | Search memory by project/session with plain and disclosure output paths. |
| Claude | Claude adapter disclosure | covered | Exercise search → expand → source/citation disclosure flow. |
| Codex | Codex adapter scan | ready | Recursively scan `~/.codex/sessions`, match by `session_meta.payload.cwd`, and count malformed/unsupported records. |
| Codex | Codex adapter import | partial | Existing explicit import path remains mutation-only; validation/replay does not import by default. |
| Codex | Codex adapter replay | ready | Normalize real Codex `response_item` message records and aggregate replay counts without transcript content. |
| CLI/API | CLI / API / reporting | ready | Provide `claude-memory-layer codex validate` / `codex replay` with JSON/Markdown reports. |
| Safety | Safety / dry-run | ready | Default Codex validation is read-only, avoids Claude settings/memory mutation, and can anonymize project labels. |

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

## Evidence

- `tests/core/product-validation-matrix.test.ts` checks coverage, summary, and Markdown rendering of the matrix.
- `tests/core/codex-session-history-importer-validation.test.ts` covers Codex dry-run scan/replay, cwd project matching, malformed lines, unsupported/tool-ish records, empty assistant messages, large/truncated content, missing cwd, all-session summary, and transcript exclusion.
- `tests/apps/codex-validation-output.test.ts` covers JSON and Markdown reporting helpers.
- `src/services/codex-session-history-importer.ts` implements read-only scan/normalize/validate helpers in addition to existing explicit Codex import APIs.
- `src/apps/cli/index.ts` exposes the user-facing commands.
