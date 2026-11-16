# Codex and Hermes

[← README](../README.md)

Codex and Hermes sessions go into the same project-scoped memory as Claude Code. Codex can load and store memory automatically through opt-in lifecycle hooks; Hermes history is imported explicitly. Both can also query memory through the MCP server ([MCP.md](MCP.md)).

## Codex

### Automatic memory with lifecycle hooks (opt-in)

```bash
# once
claude-memory-layer codex hooks install

# restart Codex, review and trust the new definitions in /hooks, then check
claude-memory-layer codex hooks status --project /path/to/project

# removes only the memory hooks; other Codex hooks are kept
claude-memory-layer codex hooks uninstall
```

`codex hooks install` merges SessionStart, UserPromptSubmit and SessionEnd hooks into `~/.codex/hooks.json`. Codex runs them only after you restart it and trust the new definitions in `/hooks`.

- **SessionStart** injects the project's core memory and an index of recent work memories into Codex. Ordinary memories are given as a title, a short summary, a `mem:` source ref and the session/turn position. It applies to resume, clear and compact as well as new sessions.
- **UserPromptSubmit** searches a memory index for each prompt. Codex expands the original text with `mem-source-ref`/`mem-details` only when it needs to, and shows `📎 Recalled memories: <title> ([mem:ID])` at the end of an answer only when it actually used one.
- **SessionEnd** hands the one finished transcript to a separate worker, which imports it into the project store. Codex fires it when a session ends, for example when Codex exits or a conversation is archived or deleted.
- Automatic import skips duplicates by content hash; embeddings are computed by the existing vector worker, outside the hook time limit.
- `codex hooks status --project <path>` shows the last automatic import success/failure time and aggregate counts for that project. Transcript text is not written to the status file.
- The Codex transcript format is not a stable public API of Codex, so `codex validate` and the importer regression tests have to be kept up to date.

### Import Codex history

Codex CLI history (`~/.codex/sessions`) is checked first with a read-only validate/replay report, then stored with an explicit import.

```bash
# read-only report
claude-memory-layer codex validate --project /path/to/project --format markdown

# import this project's Codex sessions into project memory
cd /path/to/project
claude-memory-layer codex import

# import one session
claude-memory-layer codex import --project /path/to/project --session /path/to/session.jsonl

# import every Codex session into the global store (only when you mean it)
claude-memory-layer codex import --all --verbose
```

- `codex validate` (alias `codex replay`) never writes. Options: `--sessions-dir`, `--limit`, `--format json|markdown`, `--output <path>`, `--anonymize-projects` (hashed project labels instead of raw cwd paths).
- `codex import` options: `--sessions-dir`, `--limit`, `--session-limit`, `--force`, `--verbose`, `--no-process-embeddings`.
- The project filter matches `session_meta.payload.cwd`, the directory the session was started in.

## Hermes

Hermes Agent history (`~/.hermes/state.db`) is checked first with a read-only validate/replay of the original database and stored in project memory only by an explicit import. The default strategy is not a live sync but an **explicit derived import from SessionDB into memory**.

```bash
# read-only report
claude-memory-layer hermes validate --project /path/to/project --format markdown

# import this project's Hermes sessions into project memory
cd /path/to/project
claude-memory-layer hermes import

# import one Hermes session id
claude-memory-layer hermes import --project /path/to/project --session 20260505_010203_abcd1234

# import every Hermes session into the global store (only when you mean it)
claude-memory-layer hermes import --all --verbose
```

- `hermes validate` (alias `hermes replay`) never writes. Options: `--state-db`, `--limit`, `--format json|markdown`, `--output <path>`.
- `hermes import` options: `--state-db`, `--limit`, `--session-limit`, `--force`, `--verbose`, `--no-process-embeddings`.
- Hermes import stores only user/assistant turns and skips tool/system messages. The validate report contains aggregate counts only, not transcript text.

How Hermes built-in memory, `session_search` and the memory layer's context pack fit together is described in [HERMES_CML_HEADROOM_OPERATING_MODEL.md](HERMES_CML_HEADROOM_OPERATING_MODEL.md).

To move Codex or Hermes history from another server, see [IMPORT_AND_MIGRATION.md](IMPORT_AND_MIGRATION.md#moving-to-a-new-server).
