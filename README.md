# Claude Memory Layer

**English** | [한국어](README.ko.md)

Project-scoped memory for Claude Code, Codex, Hermes and MCP clients. It records your conversations per project in a local SQLite store with a LanceDB vector index, and brings relevant past decisions, errors and results back as context when you start or continue work.

## What it stores and where

Everything is stored on your machine under `~/.claude-code/memory/`, in a separate store per project.

| What | Captured by | Where |
|---|---|---|
| Your prompts and the assistant's responses | Claude Code hooks (UserPromptSubmit, Stop), Codex hooks, history import | `projects/<hash>/events.sqlite` |
| Tool observations (tool input and output) | Claude Code PostToolUse and PostToolUseFailure hooks | `projects/<hash>/events.sqlite` |
| Session summaries | Session hooks (LLM-written by default, see [Privacy](#privacy-and-security)) | `projects/<hash>/events.sqlite` |
| Compaction checkpoints (where a session stood before Claude Code compacted it) | Claude Code PreCompact hook | `projects/<hash>/events.sqlite` |
| Facets, actions, checkpoints, lessons, actor cards | CLI and MCP tools | `projects/<hash>/events.sqlite` |
| Vector embeddings (derived, rebuildable from SQLite) | Vector worker | `projects/<hash>/vectors/` (LanceDB) |
| Local embedding model (downloaded on first use) | Embedder | `models/` |
| Optional feature flags | You | `operations.json` |

SQLite is the source of truth; the vector index is a derived accelerator. Worktrees and subdirectories of one git repository share the main checkout's store. Details: [project scope](docs/CONFIGURATION.md#project-scope).

## Install in 60 seconds

Requires **Node.js 20.19+**. Connect Claude Code in **one** of these two ways. Using both registers the hooks twice.

**① npm global install + `install`** (writes the hooks into `~/.claude/settings.json`)

```bash
npm install -g claude-memory-layer@latest
claude-memory-layer install
```

**② Claude Code plugin marketplace** (run inside Claude Code)

```text
/plugin marketplace add buzzni/claude-memory-layer
/plugin install memory-layer@claude-memory-layer
```

On Claude Code 2.1.275 or later this also works in one step:

```text
/plugin install memory-layer --marketplace buzzni/claude-memory-layer
```

The plugin's hooks run the npm package, so also run `npm install -g claude-memory-layer@latest`. Without the package the plugin does nothing. The plugin also adds slash commands such as `/memory-layer:memory-search`, which run the `claude-memory-layer` CLI on `PATH`; see [docs/INSTALL.md](docs/INSTALL.md#b-claude-code-plugin-marketplace).

Restart Claude Code afterwards. If you upgrade from an earlier version and use ①, run `claude-memory-layer install` again so newly added hooks (such as PreCompact and PreToolUse) are registered; `doctor` reports any that are missing. To switch from one to the other, keep only the plugin with `claude-memory-layer uninstall`, or keep only the `settings.json` hooks with `claude plugin uninstall memory-layer@claude-memory-layer`. `claude-memory-layer doctor` warns when both are active.

Local checkout, embedding model, scheduled maintenance and CUDA 11 troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Check your first memories

```bash
claude-memory-layer status     # are the hooks installed?
claude-memory-layer doctor     # Node, embedding backend, PATH, hooks, MCP configs, store access

cd /path/to/your-project
claude-memory-layer import     # optional: load this project's existing Claude Code sessions
claude-memory-layer search "auth design"
claude-memory-layer stats
claude-memory-layer dashboard  # local web dashboard on http://localhost:37777
```

After that the hooks work on their own. SessionStart loads project context, UserPromptSubmit searches related memories for each prompt, and UserPromptSubmit, PostToolUse, PostToolUseFailure (tool calls that failed), Stop and SessionEnd store what happened. Before Claude Code compacts the conversation, PreCompact saves a checkpoint of where the session stood, and the SessionStart that follows the compaction puts it back first. PreToolUse can add what earlier sessions left about a file before it is edited; it stays off until `preEditCheck` is enabled in `operations.json` ([pre-edit check](docs/HOW_IT_WORKS.md#pre-edit-check)).

## Features

- **Automatic capture and recall** in Claude Code through eight lifecycle hooks, with one store per project.
- **Hybrid retrieval**: keyword and semantic search, progressive disclosure (`search --disclosure`, then `expand` and `source`), and `[mem:…]` citations that MCP tools resolve back to the source event.
- **History import** for Claude Code, Codex and Hermes sessions, with a read-only validation report before any Codex or Hermes import.
- **MCP server** (`claude-memory-layer-mcp`) with a context pack for starting work, a project timeline and privacy-filtered source refs, plus tool profiles and a read-only mode.
- **Memory operations**: facets, actions, frontier, checkpoints, retention audit, graph query and procedural lessons, so the next task can be resumed from memory.
- **Perspective memory**: actor cards and observer→observed observations for multi-agent work.
- **Local dashboard**: event browser, search, retrieval traces and vector health. It binds to localhost by default and takes an optional password.
- **Vector outbox**: SQLite writes and vector jobs are queued in one transaction, with worker locks and stuck-job recovery.
- **Optional extras**: Mongo sync between servers, Endless Mode, and a read-only DART/FRED/Finnhub market-context tool.

See the [CLI reference](docs/CLI.md) and [how it works](docs/HOW_IT_WORKS.md).

## Codex, Hermes and other MCP clients

**Codex.** `claude-memory-layer codex hooks install` adds SessionStart, UserPromptSubmit and SessionEnd hooks to `~/.codex/hooks.json`. After you restart Codex and trust them in `/hooks`, Codex receives project memory at session start and for each prompt, and finished sessions are imported automatically. Existing Codex history is imported with `codex validate` (read-only report) and then `codex import`. See [docs/CODEX_AND_HERMES.md](docs/CODEX_AND_HERMES.md).

**Hermes.** Hermes history in `~/.hermes/state.db` is imported explicitly: `hermes validate` writes a read-only report, then `hermes import` stores the user and assistant turns in project memory. See [docs/CODEX_AND_HERMES.md](docs/CODEX_AND_HERMES.md#hermes).

**MCP clients.** `claude-memory-layer mcp install` registers the MCP server in Claude Desktop. For Codex, Hermes and other clients, register the `claude-memory-layer-mcp` stdio binary, for example `codex mcp add claude-memory-layer -- claude-memory-layer-mcp`. Tools, profiles and the read-only mode are described in [docs/MCP.md](docs/MCP.md).

## Configuration

Features that change search ranking or collect data in the background are opt-in and are turned on in one machine-wide file. For example, codify-lite links memories to the files a session touches:

```bash
mkdir -p ~/.claude-code/memory
cat > ~/.claude-code/memory/operations.json <<'JSON'
{ "enabled": true, "codifyLite": { "enabled": true } }
JSON
```

Hooks pick it up in the next session. Recall thresholds, retrieval mode, LLM summary/lesson settings and other environment variables are listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Troubleshooting

- Run `claude-memory-layer doctor` first. It checks Node version, the embedding backend, duplicate installs on `PATH`, hooks, MCP client configs and store write access. `doctor --fix` repairs the embedding backend when that is safe.
- `npm install` fails with `CUDA 11 binaries are not supported by this script yet`: see [CUDA 11 troubleshooting](docs/INSTALL.md#troubleshooting-cuda-11-and-onnxruntime-node).
- Context appears twice, or `doctor` warns that the hooks are registered twice: both `install` and the plugin are active. The plugin skips its own copy only when it can confirm the `settings.json` hook is the same one, so keep just one of them (see [Install](#install-in-60-seconds)).
- Sessions from before you installed are not in memory: run `claude-memory-layer import` in that project to load them.

## Uninstall

```bash
claude-memory-layer uninstall                # or: claude plugin uninstall memory-layer@claude-memory-layer
claude-memory-layer codex hooks uninstall    # if you installed the Codex hooks
claude-memory-layer maintenance uninstall    # if you installed scheduled maintenance
npm uninstall -g claude-memory-layer
```

These commands remove only hooks and scheduler definitions. Your memory stays in `~/.claude-code/memory/` until you delete that directory.

## Privacy and security

- Memory is stored unencrypted on your machine. Nothing reports usage or errors to a remote service.
- **Some features do send data off the machine.** LLM session summaries are **on by default**, and so is LLM lesson extraction when the `mem-lesson-candidates` MCP tool is called. Both pass conversation content to the local `claude` (or `codex`) CLI, which sends it to its provider under your account. Use `CLAUDE_MEMORY_SUMMARY_MODE=rule` for rule-based summaries and `CLAUDE_MEMORY_LESSON_MODE=off` to stop lesson extraction. Dashboard chat, Mongo sync, intent rewriting and the market-context tool also send data, but only when you use them.
- Before storing, the hooks replace `<private>…</private>` blocks with `[PRIVATE]` in prompts, responses, tool input, tool output and stderr, and mask credential patterns as `[REDACTED]`. A `<private>` tag that is never closed masks everything from it to the end of that text as `[PRIVATE: unclosed]`, even when the tag name is only mentioned in prose outside inline code. The filters are pattern-based.
- The dashboard binds to localhost by default. Without a password its API has no authentication, so set `--password` before binding to `0.0.0.0`.
- The dashboard only answers requests addressed to `localhost`, `127.0.0.1` or `[::1]`. To reach it over the LAN with `0.0.0.0` or through a reverse proxy, also set `DASHBOARD_ALLOWED_HOSTS`.

[SECURITY.md](SECURITY.md) has the full list of what leaves the machine, the masking table and how to report a vulnerability.

## Documentation

| Document | Contents |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Install options, plugin vs `install`, embedding model, maintenance, CUDA 11 troubleshooting |
| [docs/CLI.md](docs/CLI.md) | CLI commands with examples |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Project scope and `.claude-memory-root`, `operations.json` feature flags, environment variables |
| [docs/IMPORT_AND_MIGRATION.md](docs/IMPORT_AND_MIGRATION.md) | Importing history, moving to a new server |
| [docs/CODEX_AND_HERMES.md](docs/CODEX_AND_HERMES.md) | Codex lifecycle hooks, Codex and Hermes import |
| [docs/MCP.md](docs/MCP.md) | MCP setup, tool list, read-only mode, lesson extraction settings |
| [docs/MCP_TOOL_PROFILES.md](docs/MCP_TOOL_PROFILES.md) | MCP tool profiles |
| [docs/DASHBOARD.md](docs/DASHBOARD.md) | Web dashboard and health endpoints |
| [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) | Architecture, storage and retrieval flow, citations, Endless Mode |
| [docs/MONGO_SYNC.md](docs/MONGO_SYNC.md) | Optional multi-server sync through MongoDB |
| [docs/LESSON_SHARING.md](docs/LESSON_SHARING.md) | Share curated lessons with a team as reviewed files in git (`lesson export` / `lesson import`) |
| [docs/EXTERNAL_MARKET_CONTEXT.md](docs/EXTERNAL_MARKET_CONTEXT.md) | Read-only DART/FRED/Finnhub market context |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Operations runbook |
| [docs/OPERATIONS.md#llm-provider-circuit-breaker](docs/OPERATIONS.md#llm-provider-circuit-breaker) | LLM provider circuit breaker: skipped calls, kept summaries, doctor/audit |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Retrieval benchmarks: commands, datasets, baselines, limits |
| [SECURITY.md](SECURITY.md) | Threat model, data that leaves the machine, vulnerability reports (Korean) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, checks, PR and release flow (Korean) |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Development

```bash
npm ci
npm run build
npm run verify              # typecheck + lint + test
npm run check:architecture  # import boundary check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
