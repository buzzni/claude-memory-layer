# Importing History and Moving to a New Server

[← README](../README.md)

This page covers loading existing conversation history into project memory, and setting up a new server with the history from an old one. Codex and Hermes import options are detailed in [CODEX_AND_HERMES.md](CODEX_AND_HERMES.md).

## Import existing Claude Code history

If you have used Claude Code before installing, import the sessions it already wrote under `~/.claude/projects/`:

```bash
cd /path/to/your-project
claude-memory-layer list --project "$PWD"   # sessions for this project (without --project: all projects)
claude-memory-layer import                   # import this project's sessions, then embed them
```

| Option | Meaning |
|---|---|
| `-p, --project <path>` | Import from a specific project path |
| `-s, --session <file>` | Import one session file (JSONL) |
| `-a, --all` | Import all sessions from all projects |
| `-l, --limit <number>` | Limit messages per session |
| `--session-limit <number>` | Limit recent matching sessions to import |
| `-f, --force` | Replace the prompts and responses earlier imports of each session's transcript wrote: delete them with their vectors, then import the transcript again (see the notes below) |
| `--embedding-model <name>` | Embedding model override (see [INSTALL.md](INSTALL.md#embedding-model)) |
| `-v, --verbose` | Show detailed progress |

Notes:

- Repeat the same flow in each project. Every project gets its own store under `~/.claude-code/memory/projects/<hash>`; see [CONFIGURATION.md](CONFIGURATION.md#project-scope) for how worktrees and workspace roots are grouped.
- Import skips duplicates by content hash, so running it again does not store the same content twice. `--force` deletes only the prompts and responses that earlier imports of the same transcript wrote, with their vectors and embedding jobs, and imports the transcript again; the rows it puts back get new event ids and are embedded again. Rows the hooks and the daemon wrote (session summaries, tool observations, hook prompts and responses), rows `mongo-sync` pulled and rows a lesson cites stay. With `--limit`, a session the limit could cut short is skipped with nothing deleted, and the command exits 1. See [OPERATIONS.md](OPERATIONS.md#what-unattended-work-changes-and-what-it-does-not) for the exact rule and its limits (#227, #250).
- `import --all` imports every Claude Code session into the global store. If per-project context quality matters, run `import --project <path>` in each repository instead. The same applies to `codex import --all` and `hermes import --all`.

### Import legacy Markdown memory

`organize-import` reads existing Markdown memory files and stores them through the structured path. If the source has no Markdown, it can bootstrap knowledge documents from the codebase and git history.

```bash
# Preview without saving
claude-memory-layer organize-import /path/to/legacy-memory --dry-run

# Import
claude-memory-layer organize-import /path/to/legacy-memory --project /path/to/project

# Bootstrap from code and git when there is no Markdown yet
claude-memory-layer organize-import /path/to/empty-dir --bootstrap --repo /path/to/codebase
```

Run `claude-memory-layer organize-import --help` for the bootstrap options (`--force-bootstrap`, `--no-bootstrap-if-empty`, `--incremental`/`--no-incremental`, `--out`, `--limit`).

## Moving to a new server

Use this checklist when you install on a new server and want the old server's Claude Code, Codex or Hermes conversations in memory.

### 1. Prepare the new server

```bash
node --version   # Node.js 20.19 or later
npm install -g claude-memory-layer@latest
claude-memory-layer install
claude-memory-layer status
```

`claude-memory-layer install` registers the Claude Code hooks. If Claude Code is already running, restart it so the hooks take effect. (Or install the Claude Code plugin instead; see [INSTALL.md](INSTALL.md).)

### 2. Copy the original conversation history

The safest approach is to copy the **original conversation history** to the new server and import it again there. Copy only what you need. These directories and databases can contain sensitive conversations and paths: do not commit or share them, and copy them only over a trusted channel such as SSH or a private network.

```bash
# Claude Code sessions (JSONL)
mkdir -p ~/.claude/projects
rsync -a OLD_HOST:~/.claude/projects/ ~/.claude/projects/

# Codex CLI sessions (JSONL), only if you also want Codex history
mkdir -p ~/.codex/sessions
rsync -a OLD_HOST:~/.codex/sessions/ ~/.codex/sessions/

# Hermes Agent SessionDB, only if you also want Hermes history.
# Recommended: stop Hermes (gateway/agent processes) on OLD_HOST first and copy the SQLite sidecars too.
mkdir -p ~/.hermes
rsync -a OLD_HOST:'~/.hermes/state.db*' ~/.hermes/
```

If Hermes cannot be stopped on a production server, take a consistent snapshot with SQLite `.backup` on OLD_HOST instead of copying `state.db` directly:

```bash
ssh OLD_HOST 'sqlite3 ~/.hermes/state.db ".backup /tmp/hermes-state.db.backup"'
mkdir -p ~/.hermes
rsync -a OLD_HOST:/tmp/hermes-state.db.backup ~/.hermes/state.db
```

You can also copy an already-processed memory store as is, after stopping every writer on both servers (agents, dashboard, semantic daemon, workers). For reproducibility and model/version migrations, re-importing the original history (above) is preferred.

```bash
mkdir -p ~/.claude-code
rsync -a OLD_HOST:~/.claude-code/memory/ ~/.claude-code/memory/
```

### 3. Validate read-only, then import per project

Project memory is separated by project path. Put the repository's path on the new server in `PROJECT` and run only the importers you need.

The project filter of the Claude Code, Codex and Hermes importers matches the **absolute path the conversation was created in**. If the repository has the same absolute path on both servers, use this:

```bash
export PROJECT=/path/to/your-project
cd "$PROJECT"

# Claude Code: list importable sessions, then import into project memory
claude-memory-layer list --project "$PROJECT"
claude-memory-layer import --project "$PROJECT" --verbose

# Codex: read-only report first, then an explicit import
claude-memory-layer codex validate --project "$PROJECT" --format markdown
claude-memory-layer codex import --project "$PROJECT" --verbose

# Hermes: read-only report first, then an explicit import
claude-memory-layer hermes validate --project "$PROJECT" --format markdown
claude-memory-layer hermes import --project "$PROJECT" --verbose

# Process any pending embeddings
claude-memory-layer process --project "$PROJECT"
```

If the absolute paths differ, find the original sessions with `OLD_PROJECT` and import specific session files or ids into the new project store (`NEW_PROJECT`). The Markdown validate reports contain aggregate counts only, so take the Codex session file paths and Hermes session ids from the JSON report: each entry of `sessions[]` has `sessionId`, `matched` and, for Codex, `filePath`.

```bash
export OLD_PROJECT=/old/server/path/to/your-project
export NEW_PROJECT=/path/to/your-project
cd "$NEW_PROJECT"

# Claude Code: take the JSONL path from the "Path:" lines of the list output (first 20 sessions)
claude-memory-layer list --project "$OLD_PROJECT"
claude-memory-layer import --project "$NEW_PROJECT" --session /path/to/claude-session.jsonl --verbose

# Codex: print the session file paths from the JSON report, then import each one
claude-memory-layer codex validate --project "$OLD_PROJECT" --format json \
  | node -e 'for (const s of JSON.parse(require("fs").readFileSync(0, "utf8")).sessions) if (s.matched) console.log(s.filePath)'
claude-memory-layer codex import --project "$NEW_PROJECT" --session /path/to/codex-session.jsonl --verbose

# Hermes: print the session ids from the JSON report, then import each one
claude-memory-layer hermes validate --project "$OLD_PROJECT" --format json \
  | node -e 'for (const s of JSON.parse(require("fs").readFileSync(0, "utf8")).sessions) if (s.matched) console.log(s.sessionId)'
claude-memory-layer hermes import --project "$NEW_PROJECT" --session 20260505_010203_abcd1234 --verbose

claude-memory-layer process --project "$NEW_PROJECT"
```

The output of `import`, `validate` and `list` can include parts of conversations and local paths (the JSON reports list session file paths). Remove sensitive data and paths before sharing it; for Codex validate reports you can add `--anonymize-projects`, which hashes the project labels but not `filePath`.

### 4. Verify

```bash
export VERIFY_PROJECT=/path/to/your-project  # the PROJECT or NEW_PROJECT used above
claude-memory-layer stats --project "$VERIFY_PROJECT"
claude-memory-layer search "what I was working on recently" --project "$VERIFY_PROJECT" --top-k 5
claude-memory-layer dashboard --no-open --port 37777
# in another terminal: curl http://localhost:37777/api/health

# aggregate-only report on how project stores are split
claude-memory-layer project scope-audit --days 7
```

### 5. Connect MCP clients and other agents

See [MCP.md](MCP.md) for Claude Desktop, Codex and Hermes.
