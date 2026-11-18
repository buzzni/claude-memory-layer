# Configuration

[← README](../README.md)

## Project scope

Each project uses its own store under `~/.claude-code/memory/projects/<hash>`, so memories are separated automatically. Worktrees and subdirectories inside one git repository converge on the main checkout's store. Most commands take `--project <path>` when you want to name the project explicitly.

### Grouping directories across git boundaries: `.claude-memory-root`

Sometimes you want to converge across git boundaries, for example when a workspace product creates a directory per chat or instance (each possibly its own git repository) and memory gets fragmented. Put a marker file at the workspace root, and every path below it shares that directory's single store:

```bash
touch <workspace-root>/.claude-memory-root
```

- The marker must be a **regular file**; a directory with that name is ignored. Its content is not read.
- The hash of the marker directory itself does not change, so a store that already existed at that path continues as before.
- The nearest (innermost) marker wins, so nested workspaces stay separate.
- A marker takes precedence over sub-repositories with their own `.git`; that is the reason this opt-in exists.
- The marker is looked up by walking up from the base path **after** git convergence. So a worktree checked out outside the workspace still reaches the marker through its main checkout, a root marker committed to a repository does not split worktrees into separate stores, and a marker in a repository **subdirectory** is ignored (a subtree is not split from the repository's store).
- Markers in the home directory, the system temp root or the file system root are ignored, so one stray marker cannot merge every project on the machine into one store.
- Hooks start a new process each time and pick up a marker immediately; long-running processes (MCP server, dashboard, daemon) need a restart.
- Past data in existing fragmented stores is not merged automatically (convergence starts with new sessions). Running project-scope repair on an old fragmented store after adopting a marker can quarantine past rows whose hash no longer matches, so be careful.

`claude-memory-layer project scope-audit --days 7` gives an aggregate-only report of how recent activity is split across stores.

## Optional features: `operations.json`

Features that change search ranking or collect data in the background are opt-in, controlled by one file, `~/.claude-code/memory/operations.json` (v2.2.0+). The same file tunes the session summary refresh, which is on by default:

```bash
mkdir -p ~/.claude-code/memory
cat > ~/.claude-code/memory/operations.json <<'JSON'
{
  "enabled": true,
  "codifyLite": { "enabled": true }
}
JSON
```

- **Scope**: machine-wide. This one file applies to every project on the machine.
- **When it takes effect**: hooks run as a new process per session, so the next session picks it up. Long-running processes such as the MCP server and the semantic daemon need a restart.
- **Turning off**: set the flag to `false` or delete the file.
- **Safety**: if the file is missing, is not valid JSON or does not match the schema, it is ignored silently and the defaults apply (it never fails session start). Set `CLAUDE_MEMORY_DEBUG` to log why it was ignored.
- **Other location**: `CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH` points to a different file (mainly for tests and isolation).

Flags (the full schema is `MemoryOperationsConfigSchema` in `src/core/types.ts`):

| Flag | Default | Effect |
|---|---|---|
| `codifyLite.enabled` | `false` | Records a `source_file` entity and `touched_in` edge for every tool call that touches a file, and turns on a session-file search lane that surfaces past memories linked to files the current session touches. Recommended. |
| `preEditCheck.enabled` | `false` | Before an edit tool runs, adds lessons, failed tool runs and session summaries about that file ([pre-edit check](HOW_IT_WORKS.md#pre-edit-check)). Adds about 100 ms to each edit while on. |
| `graphExpansion.enabled` | `false` | Graph-expansion search lane based on entities extracted from the query. Its effect on ranking has not been validated; keep the default. |
| `sourceTrust.excludeUntrustedFromAutoInjection` | `false` | Keeps tool-output and unknown-origin memories out of automatic injection (SessionStart and UserPromptSubmit hooks, Claude and Codex; in the pre-edit check, the failed tool runs). MCP tools and CLI `search` still return them, labelled; imported memories stay injected, labelled. The filter runs before ranking, so other memories can take the freed slots and the result is not a subset of the flag-off injection. The "Hook-injected memories by origin" table of `memory-audit` shows how many injections it would remove. See [HOW_IT_WORKS.md](HOW_IT_WORKS.md#source-trust-labels). |
| `sessionSummaryRefresh.enabled` | `true` | Writes a session's LLM summary again as the session grows, replacing the old one ([session summaries](HOW_IT_WORKS.md#session-summaries)). Independent of the top-level `enabled`. `false` keeps the first summary as the only one. Each refresh is one more summary call to the provider |
| `sessionSummaryRefresh.minNewExchanges` | `10` | Prompts and answers a session must gain after its summary before the next refresh (2–1000; 10 is about five turns) |
| `sessionSummaryRefresh.maxRefreshesPerSession` | `3` | Refreshes per session after the first summary (0–100). Answers with nothing worth keeping count too |
| `capturePolicy.skipSubagentTypes` | `[]` | Types (`agent_type`, e.g. `"Explore"`) of **subagents and in-process agent-team teammates** whose tool calls the PostToolUse and PostToolUseFailure hooks do not store. See [Capture policy](#capture-policy) below for what it covers and how types match. |
| `retention.enabled`, `lessons.enabled`, `perspectiveMemory.*` | `false` | Retention audit, lessons and perspective memory sub-features, as needed. |
| `facets.enabled`, `actions.enabled` | `true` | Facets and actions. |
| `enabled` | `false` | Top-level switch of the operations layer. |

### Capture policy

`capturePolicy.skipSubagentTypes` keeps some tool calls out of the store. Example: `{ "capturePolicy": { "skipSubagentTypes": ["Explore"] } }`.

- **Who it covers**: hook input that carries `agent_id`. Claude Code sets that field for a subagent *or* an in-process agent-team teammate, and no documented field tells the two apart (their tool-call inputs have the same fields), so a listed type covers both. A main session started with `claude --agent` carries `agent_type` but no `agent_id`, so it is still stored.
- **Matching**: each configured value is trimmed, then compared with `agent_type` exactly and case-sensitively (`"explore"` does not match `Explore`). Only a lone `"*"` is a wildcard; it matches every subagent and teammate, including one without `agent_type`. There are no other patterns (`"Expl*"` matches nothing). A blank value is a schema error, which makes the whole file ignored.
- **What it changes**: only what PostToolUse and PostToolUseFailure store. The tool call is not stored, so nothing is derived from it either (no `source_file` / `touched_in` link from codify-lite). It runs after the existing tool blocklist and output filters, so it removes only calls that would otherwise have been stored. The session is never blocked, and recall injection is unchanged, including the pre-edit check inside a subagent.
- **What it does not change**: it does not delete or hide transcripts, and it does not stop `import` from reading them. The parent session's own `Agent` tool call is still stored. For a foreground subagent, that call's response is the subagent's final result. For a background launch, the response is only the launch notice (`status: "async_launched"`). A subagent that reports through `SubagentHandback` can leave a notice instead of its report. So the subagent's final result is not guaranteed to be stored.
- **Seeing it**: skips are counted per store and reason code (`subagent_or_teammate`) in the "Not stored by the capture policy" table of `memory-audit`. Rows hold no session id. `doctor` shows the active setting.
- **Codex**: Codex hooks store no tool calls, so the flag does not apply to them.

Core memory blocks, `mem-entity-supersede` and temporal graph queries are always available regardless of these flags. The flags gate only the parts that change behavior without you doing anything, such as automatic collection and search ranking.

## Environment variables

### Recall tuning (Claude Code hooks)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEMORY_RETRIEVAL_MODE` | `hybrid` | `keyword`, `hybrid` or `semantic` |
| `CLAUDE_MEMORY_SEMANTIC_DAEMON_IDLE_MS` | `600000` | Idle time before the semantic daemon exits |
| `CLAUDE_MEMORY_MIN_SCORE` | `0.4` | Minimum score for injected memories |
| `CLAUDE_MEMORY_FALLBACK_MIN_SCORE` | `0.3` | Retry threshold used when the first search returns nothing |
| `CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT` | off | `true` scores FTS hits on the absolute bm25 scale `x/(x+15)` instead of relative to the result list, so a hit on one common token no longer gets 1.0 |
| `CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT` | off | `true` shortens a current prompt longer than 200 chars before searching: the last sentence ending in `?`, else the last sentence with a Korean question or request ending (`…까`, `…나요`, `…해줘`), else the last sentence, else the last 250 chars. Paths, `#numbers` and commit SHAs from the dropped part are appended to the query |
| `CLAUDE_MEMORY_HOOK_TIMEOUT_MS` | `30000` | Overall time limit of a hook run |

### LLM summaries and lessons

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEMORY_SUMMARY_MODE` | LLM | `rule` (or `off`) uses the rule-based summary instead of the LLM; no data is sent to a provider |
| `CLAUDE_MEMORY_SUMMARY_PROVIDER` | `claude` | `claude` or `codex` CLI |
| `CLAUDE_MEMORY_SUMMARY_MODEL`, `CLAUDE_MEMORY_SUMMARY_TIMEOUT_MS` | | Model and timeout for the summary CLI call |
| `CLAUDE_MEMORY_LESSON_MODE`, `CLAUDE_MEMORY_LESSON_PROVIDER`, `CLAUDE_MEMORY_LESSON_MODEL`, `CLAUDE_MEMORY_LESSON_TIMEOUT_MS` | | Lesson extraction, see [MCP.md](MCP.md#llm-lesson-extraction) |
| `CLAUDE_MEMORY_LLM_BREAKER` | on | `off` turns the [provider circuit breaker](OPERATIONS.md#llm-provider-circuit-breaker) off |
| `CLAUDE_MEMORY_LLM_BREAKER_THRESHOLD` | `3` | Consecutive auth/usage-limit failures that open the breaker |
| `CLAUDE_MEMORY_LLM_BREAKER_COOLDOWN_MS` | `300000` | Wait before the first probe |
| `CLAUDE_MEMORY_LLM_BREAKER_MAX_COOLDOWN_MS` | `3600000` | Cap for the cooldown, which doubles after each failed probe |

How often a summary is written again as the session grows is set in `operations.json` (`sessionSummaryRefresh`, above).

Both CLI timeouts are capped at `1800000` (30 minutes); a larger value runs with the cap. `doctor` warns about a larger
value set in the shell it runs in; a value that reaches only the daemon (`settings.json` `env`) is not visible to it.

What these send off the machine is described in [SECURITY.md](../SECURITY.md).

### Other

| Variable | Meaning |
|---|---|
| `CLAUDE_MEMORY_EMBEDDING_MODEL` | Embedding model override (see [INSTALL.md](INSTALL.md#embedding-model)) |
| `CLAUDE_MEMORY_MCP_PROFILE`, `CLAUDE_MEMORY_MCP_READ_ONLY`, `CLAUDE_MEMORY_MCP_IDLE_RELEASE_MS` | MCP server, see [MCP.md](MCP.md) |
| `DASHBOARD_PASSWORD`, `DASHBOARD_HOST`, `DASHBOARD_ALLOWED_ORIGINS` | Dashboard, see [DASHBOARD.md](DASHBOARD.md) |
| `DASHBOARD_ALLOWED_HOSTS` | Extra `Host` names the dashboard answers besides `localhost`/`127.0.0.1`/`[::1]` on its port (comma-separated `hostname` or `hostname:port`). Needed for `0.0.0.0` LAN or reverse-proxy access, see [DASHBOARD.md](DASHBOARD.md#security) |
| `CLAUDE_MEMORY_MONGO_URI`, `CLAUDE_MEMORY_MONGO_DB`, `CLAUDE_MEMORY_MONGO_PROJECT` | Mongo sync, see [MONGO_SYNC.md](MONGO_SYNC.md) |
| `CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL` | `1` skips the embedding backend download during install |
