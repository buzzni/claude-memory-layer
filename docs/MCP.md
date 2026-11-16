# MCP Server

[← README](../README.md)

The package ships an MCP stdio server as the `claude-memory-layer-mcp` bin (`dist/mcp/index.js`). Claude Desktop, Claude Code, Codex, Hermes and other MCP clients can use it to query the same project-scoped memory.

## Setup

### Claude Desktop

```bash
claude-memory-layer mcp install
# then restart Claude Desktop
```

By default this records the currently running `node` and the absolute path of this install's MCP entry point, so it does not depend on the GUI app's `PATH` or an older nvm install. It keeps existing values in the Claude Desktop config (on macOS `~/Library/Application Support/Claude/claude_desktop_config.json`) and adds or updates this entry:

```json
{
  "mcpServers": {
    "claude-memory-layer": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/claude-memory-layer/dist/mcp/index.js"]
    }
  }
}
```

Options:

```bash
claude-memory-layer mcp install --dry-run
claude-memory-layer mcp install --config-path /path/to/claude_desktop_config.json
claude-memory-layer mcp install --server-name claude-memory-layer --command claude-memory-layer-mcp
```

With `--command`, that value is written as is.

### Codex, Hermes and other clients

Register the globally installed stdio binary:

```bash
# Codex
codex mcp add claude-memory-layer -- claude-memory-layer-mcp

# Hermes
hermes mcp add claude-memory-layer --command claude-memory-layer-mcp
```

If the client cannot find it on its `PATH`, use the absolute path from `command -v claude-memory-layer-mcp`. From a local checkout, register the built server directly after `npm run build`:

```bash
codex mcp add claude-memory-layer -- node /path/to/claude-memory-layer/dist/mcp/index.js
hermes mcp add claude-memory-layer --command node --args /path/to/claude-memory-layer/dist/mcp/index.js
```

`claude-memory-layer doctor` checks, read-only, whether the MCP command in the Claude Code (`~/.claude.json`), Claude Desktop and Codex (`~/.codex/config.toml`) configs points to the same install as the current CLI. If it is a bare `PATH` name or points to another install, doctor prints the command that fixes it.

### Lifecycle

The server cleans up and exits when the client's stdio closes or its parent process disappears. While connected but idle, it releases the embedding model and native resources after 10 minutes by default and prepares them again on the next call. Set `CLAUDE_MEMORY_MCP_IDLE_RELEASE_MS` (60000–86400000 ms) to change that; a value outside the range falls back to the default. Restart the MCP process after installing a new version.

## Profiles

`CLAUDE_MEMORY_MCP_PROFILE` selects the tool surface: `core`, `operations`, `governance`, `experimental` or `all`. The default `all` keeps the full tool list. For a small context/search surface, set `CLAUDE_MEMORY_MCP_PROFILE=core` in the `env` of the MCP server entry. Scope per profile, mutation classification and rollback: [MCP_TOOL_PROFILES.md](MCP_TOOL_PROFILES.md).

## Read-only mode

For lookups from a write-restricted sandbox, set `CLAUDE_MEMORY_MCP_READ_ONLY=1` in the `env` of the MCP server entry. It is also used when a host that owns automatic recall passes `CLAUDE_MEMORY_RECALL_OWNER=host`. From the selected profile it exposes only `mem-context-pack`, `mem-search`, `mem-timeline`, `mem-details`, `mem-project-timeline`, `mem-source-ref`, `mem-stats`, `mem-lesson-get`, `mem-lesson-list` and `external-market-context`. Other tools, and an explicit freshness refresh (`mem-context-pack` with `refreshLatest=true`), are rejected with a `read_only_runtime` error.

Lookups in this mode use a temporary SQLite snapshot and lexical search. They do not initialize the semantic model or vectors, do not import automatically and do not record lookup telemetry, so semantic search quality and usage counts differ. `mem-stats` reads counts from an existing vector index read-only. `mem-context-pack` with `refreshLatest=false` also works without model initialization. The process still needs permission to read the memory files and to write a temporary directory outside the canonical memory; this setting does not grant sandbox permissions. A snapshot taken during a concurrent checkpoint can miss the latest data; if freshness matters, repeat the lookup or import and query from a writable runtime.

## Tools

Most project-scoped tools accept or require `projectPath`. Mutating tools require an audit `actor` and evidence or source refs, and avoid printing raw transcripts, paths or secrets.

| Profile | Tool | Description |
|---|---|---|
| core (every profile) | `mem-search` | Search project/session-scoped memory; returns a compact index |
| | `mem-timeline` / `mem-details` | Timeline around results / full content of selected memories |
| | `mem-stats` | Read-only aggregate memory/vector/outbox statistics |
| | `mem-context-pack` | Context pack for starting work: relevant memories, recent timeline and follow-up refs. Records a privacy-safe query trace for dashboard/replay usage analysis |
| | `mem-project-timeline` | Recent project memory by session, source agent, counts and safe previews |
| | `mem-source-ref` | Resolve `mem:` citations, memory ids or `event:` ids into redacted previews and safe metadata; `includeNeighbors` with `neighborWindow` (1–5) adds the surrounding events of the same session |
| operations | `mem-import-latest` | Bounded import of the latest Claude Code/Codex/Hermes sessions before retrieving context (mutates memory) |
| | `mem-facet-query` / `mem-facet-tag` | Query / tag project-scoped facets |
| | `mem-action-list` / `mem-action-update` | List / update actions |
| | `mem-frontier` | Next and blocked actions, checkpoints and safe resume hints |
| | `mem-checkpoint-create` / `mem-checkpoint-list` | Resumable checkpoints |
| | `mem-retention-audit` | Dry-run retention governance audit |
| governance | `mem-core-block-get` / `mem-core-block-update` | Read / replace the project's core memory blocks |
| | `mem-actor-list`, `mem-actor-card-get` / `mem-actor-card-upsert` | Actors and observer→observed actor cards |
| | `mem-asset-create`, `-get`, `-list`, `-update`, `-bind`, `-grant-set`, `-check`, `-catalog-sync` | Memory asset registration and permissions (see [memory-asset-permissions.md](memory-asset-permissions.md)) |
| | `mem-shared-actor-link` / `-status` / `-unlink`, `mem-shared-search`, `mem-shared-asset-get` | Explicitly linked cross-project troubleshooting search and asset reads |
| experimental | `mem-graph-query` | Bounded graph expansion/query diagnostics; `asOf`/`knownAt` for temporal edge history |
| | `mem-entity-supersede` | Mark one entity as superseded by another (audited fact reconciliation) |
| | `mem-lesson-list` / `mem-lesson-get` | List lessons / fetch one lesson |
| | `mem-lesson-candidates` | Detect repeated successful workflows not yet saved as lessons; lesson text is extracted by an LLM (below) |
| | `mem-lesson-save` | Save a reviewed lesson |
| | `mem-perspective-query`, `mem-perspective-context` | Perspective observations and actor-card context bundles |
| | `mem-perspective-observation-create` / `-delete` | Audited observation create / soft-delete |
| | `external-market-context` | Read-only DART/FRED/Finnhub snapshot ([EXTERNAL_MARKET_CONTEXT.md](EXTERNAL_MARKET_CONTEXT.md)) |

The `all` profile (default) includes every tool above.

Example workflow:

```text
1. Start a task:          mem-context-pack(projectPath, query)
2. Check recent activity: mem-project-timeline(projectPath)
3. Need more evidence:    mem-source-ref(projectPath, ids=["mem:abc123"], includeNeighbors=true, neighborWindow=1)
```

This is most useful when Hermes, Codex and Claude Code share the same project-scoped memory. `mem-source-ref` returns allowlisted metadata and privacy-filtered previews, not raw transcripts.

## LLM lesson extraction

`mem-lesson-candidates` first mines groups of repeated successful patterns deterministically, then extracts the lesson text (name, trigger, steps, failure modes) through a subprocess of the locally logged-in `claude` (or `codex`) CLI. No separate API key is needed. Results are cached per candidate group, so later lookups and promotion return the same text. Transcripts are redacted (paths, credentials) before they are passed to the subprocess. The CLI sends that content to its provider; see [SECURITY.md](../SECURITY.md).

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEMORY_LESSON_MODE` | on | `off` disables extraction. Candidate groups are still mined but reported without lesson text, as `extraction.skippedNoExtractor` |
| `CLAUDE_MEMORY_LESSON_PROVIDER` | `claude` | `codex` is also supported |
| `CLAUDE_MEMORY_LESSON_MODEL` | `claude-haiku-4-5-20251001` for claude; the CLI's own default for codex | Passed as `--model` when set |
| `CLAUDE_MEMORY_LESSON_TIMEOUT_MS` | `120000` | Extraction timeout per group |

Each call extracts at most 3 new (uncached) groups. The remaining groups are reported in the response's `extraction` stats and `note`; calling again skips the cached groups and continues.
