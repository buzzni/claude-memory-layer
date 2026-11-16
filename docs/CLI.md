# CLI Reference

[← README](../README.md)

After a global install, run `claude-memory-layer`. From a local checkout use `npx claude-memory-layer` or `node dist/cli/index.js`. Every command has `--help`; most project-scoped commands take `-p, --project <path>` and default to the current directory.

## Commands

| Command | Purpose |
|---|---|
| `install` / `uninstall` | Add / remove the Claude Code hooks in `~/.claude/settings.json` (`install --with-maintenance` also installs the maintenance scheduler) |
| `status` | Check the hook and plugin installation |
| `doctor [--fix]` | Diagnose Node version, embedding backend, `PATH` conflicts, hooks, session-end work, MCP client configs and store access |
| `search <query>` | Search memories (`--top-k`, `--min-score`, `--strategy auto\|fast\|deep`, `--disclosure`, `--include-shared`) |
| `expand <resultId>` / `source <resultId>` | Expand a `search --disclosure` result with surrounding context / show its source |
| `history` | View stored events (`--limit`, `--session`, `--type`) |
| `stats` | Read-only store statistics |
| `health` | Read-only aggregate health reports |
| `audit` | Read-only per-project memory audit |
| `forget [eventId]` | Remove memories (`--session`, `--before <YYYY-MM-DD>` with `--type`; dry-run unless `--confirm`) |
| `list` / `import` | List / import Claude Code sessions ([IMPORT_AND_MIGRATION.md](IMPORT_AND_MIGRATION.md)) |
| `organize-import [sourceDir]` | Import legacy Markdown memory or bootstrap knowledge docs from code and git |
| `codex …` | Codex hooks, validate, replay, import ([CODEX_AND_HERMES.md](CODEX_AND_HERMES.md)) |
| `hermes …` | Hermes validate, replay, import ([CODEX_AND_HERMES.md](CODEX_AND_HERMES.md#hermes)) |
| `process` | Process pending embeddings and run one bounded graduation pass |
| `vector-status` / `vector compact` | Read-only vector outbox status / preview or apply vector compaction |
| `runtime-status` | Aggregate MCP/semantic daemon resource and model lifecycle status |
| `maintenance run\|install\|status\|uninstall` | Opt-in periodic maintenance of all local stores ([INSTALL.md](INSTALL.md#maintenance-optional)) |
| `project identity\|scope-audit\|bootstrap-health` | Inspect project storage identity and scope |
| `facet`, `action`, `frontier`, `checkpoint`, `lesson`, `retention` | Memory operations |
| `actors repair` | Backfill perspective memory actors and session memberships |
| `retrieval selections\|reevaluate` | Read-only retrieval ledger reports |
| `repair …`, `cleanup …` | Repair legacy metadata, redact stored credentials, clean up CML-owned state (dry-run by default) |
| `endless …` | Endless Mode |
| `mcp install` | Register the MCP server in Claude Desktop ([MCP.md](MCP.md)) |
| `dashboard` | Local web dashboard ([DASHBOARD.md](DASHBOARD.md)) |
| `mongo-sync` | Optional MongoDB sync ([MONGO_SYNC.md](MONGO_SYNC.md)) |
| `market-context` | Read-only DART/FRED/Finnhub context ([EXTERNAL_MARKET_CONTEXT.md](EXTERNAL_MARKET_CONTEXT.md)) |

## Examples

```bash
# search and progressive disclosure
claude-memory-layer search "React component patterns" --top-k 10
claude-memory-layer search "API error handling" --disclosure
# expand/source take the `id:` printed by search --disclosure
claude-memory-layer expand <resultId>
claude-memory-layer source <resultId>

# history and statistics
claude-memory-layer history --limit 50 --type user_prompt
claude-memory-layer stats --project /path/to/project

# Claude Code session import
claude-memory-layer list --project /path/to/project
claude-memory-layer import --project /path/to/project --verbose

# Codex/Hermes: read-only validation first, then an explicit import
claude-memory-layer codex validate --project /path/to/project --format markdown --anonymize-projects
claude-memory-layer codex import --project /path/to/project --verbose
claude-memory-layer hermes validate --project /path/to/project --format markdown
claude-memory-layer hermes import --project /path/to/project --verbose

# embedding/vector outbox processing and status
claude-memory-layer process --project /path/to/project
claude-memory-layer process --project /path/to/project --dry-run-recovery
claude-memory-layer vector-status --project /path/to/project

# aggregate-only runtime resource status of the MCP server and semantic daemon
claude-memory-layer runtime-status
claude-memory-layer runtime-status --json

# bounded maintenance of every project store on the machine
claude-memory-layer maintenance run
claude-memory-layer maintenance run --min-free-gb 10
claude-memory-layer maintenance install --interval 300
claude-memory-layer maintenance status
claude-memory-layer maintenance uninstall

# aggregate-only audit of how the registry and canonical stores are split
claude-memory-layer project scope-audit --days 7
claude-memory-layer project scope-audit --days 7 --json

# perspective memory actor/session membership backfill
claude-memory-layer actors repair --project /path/to/project --dry-run
claude-memory-layer actors repair --project /path/to/project --apply

# memory operations
claude-memory-layer facet query --project /path/to/project --dimension workflow
claude-memory-layer facet tag --project /path/to/project --target-type event --target-id <id> --dimension workflow --value release --actor <actor> --apply
claude-memory-layer action list --project /path/to/project
claude-memory-layer frontier --project /path/to/project --limit 20
claude-memory-layer checkpoint list --project /path/to/project
claude-memory-layer retention audit --project /path/to/project

# dashboard
claude-memory-layer dashboard --no-open
claude-memory-layer dashboard --bind localhost --port 37777 --password "<local-password>" --no-open

# external read-only market/company context
claude-memory-layer market-context --company 삼성전자 --dart-corp-code 00126380 --symbol 005930.KS --json
```

Context injected by the hooks and MCP results cite memories as `[mem:…]`. The CLI `expand` and `source` commands take the `id:` from `search --disclosure` output; to resolve a `mem:` citation, use the MCP `mem-source-ref` or `mem-details` tool.

## Endless Mode

Endless Mode keeps one continuous memory stream instead of session boundaries (experimental).

```bash
claude-memory-layer endless enable
claude-memory-layer endless status    # working set, continuity, consolidated memories, last consolidation
claude-memory-layer endless disable
```

Other subcommands: `consolidate`, `working-set` (`ws`), `memories`.

| Session mode | Endless Mode |
|---|---|
| Clear start and end | Continuous stream |
| Summary per session | Gradual consolidation |
| Empty state on restart | Previous context kept |
