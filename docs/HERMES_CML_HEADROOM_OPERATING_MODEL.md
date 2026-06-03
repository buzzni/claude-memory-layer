# Hermes, CML, and Headroom operating model

This page is the current decision boundary for Hermes Agent memory, Hermes `session_search`, Claude Memory Layer (CML), and Headroom-style compression. It is intentionally concise so future changes do not drift into duplicate source-of-truth or default runtime dependencies.

## Decision summary

- Hermes built-in memory is for small durable facts and preferences that should survive across sessions.
- Hermes `session_search` is raw Hermes transcript recall: use it to find or scroll exact prior Hermes conversations.
- CML is project-scoped cross-agent memory: use it to recover project decisions, current context, source refs, action/frontier state, and recent Claude/Codex/Hermes history that has been explicitly imported or refreshed.
- The Hermes CML memory provider is read-only pre-turn prefetch. It calls the CML MCP context-pack tool and should not write Hermes turns back to CML by default.
- Headroom is a benchmark/reference for pre-LLM compression ideas. It is not a default runtime dependency for CML.

## Layer boundaries

| Layer | Source of truth | Mutates by default? | Use when | Do not use for |
|---|---|---:|---|---|
| Hermes built-in memory | Hermes profile memory/user profile | Only when the agent explicitly saves memory | Stable user preferences, environment facts, compact project conventions | Long transcripts, volatile task progress, project-wide retrieval |
| Hermes `session_search` | Hermes SessionDB raw messages | No | Exact Hermes conversation recall, anchored scrolling, recent-session browsing | Cross-agent project memory, derived decisions, CML source refs |
| CML project memory | Project-scoped CML SQLite events plus derived indexes | Only through CML hooks/import/freshness/mutation tools | Project context packs, cross-agent recall, source-ref navigation, actions/frontier/checkpoints/facets | Live mirroring every Hermes turn by default |
| Hermes CML provider | CML MCP `mem-context-pack` response | No | Read-only automatic pre-turn project context in Hermes | Syncing or importing Hermes turns |
| Headroom-style compression | External reference/benchmark | No dependency by default | Comparing compression quality and shaping native compaction heuristics | Replacing CML source-ref-preserving compression as a required dependency |

## When to choose which tool

### Use Hermes built-in memory

Use Hermes built-in memory for compact facts that should be injected into future Hermes sessions, such as user preferences, recurring environment details, or stable project conventions. Keep it curated and small. Do not store PR numbers, commit SHAs, temporary task status, or long project transcripts there.

### Use Hermes `session_search`

Use `session_search` when the question is about what happened in a Hermes chat and exact transcript context matters.

Typical Hermes tool shapes:

```text
session_search(query="auth refactor", limit=3)
session_search(session_id="<session-id>", around_message_id=<message-id>, window=10)
session_search()
```

This is a raw transcript recall surface. It returns real Hermes messages, bookends, and scroll windows; it does not turn Hermes history into CML project memory and it does not replace CML.

### Use CML context-pack

Use CML when the agent needs project-scoped working context across Claude Code, Codex, Hermes, MCP clients, dashboards, and derived operation state.

MCP tool shape:

```json
{
  "tool": "mem-context-pack",
  "args": {
    "query": "current task or decision to recover",
    "projectPath": "/path/to/project",
    "topK": 5,
    "recentLimit": 30,
    "sessionLimit": 5,
    "compression": "safe",
    "maxChars": 6000
  }
}
```

Hermes exposes the same CML tool through its MCP wrapper, commonly as:

```text
mcp_claude_memory_layer_mem_context_pack
```

Follow-up tools:

```text
mem-source-ref        # resolve mem/event IDs into privacy-safe source previews
mem-project-timeline  # summarize recent project events by session/source
mem-import-latest     # explicitly import bounded recent local sessions before retrieval
```

## Freshness and import policy

There is no live Hermes -> CML sync by default. The safe default is:

1. Read raw Hermes history through `session_search` when exact Hermes transcript recall is needed.
2. Validate or import Hermes history into CML only when project-scoped memory should include it.
3. Use CML context-pack for project-scoped pre-turn context after the import/freshness step.

CLI freshness flow:

```bash
export PROJECT=/path/to/project

# Read-only report first; does not import or mutate CML memory.
claude-memory-layer hermes validate --project "$PROJECT" --format markdown

# Explicit import; mutates the selected project-scoped CML memory store.
claude-memory-layer hermes import --project "$PROJECT" --session-limit 1 --verbose

# Process pending embeddings/vector work if needed.
claude-memory-layer process --project "$PROJECT"

# Inspect the project memory after import.
claude-memory-layer search "recent decision" --project "$PROJECT" --top-k 5 --disclosure
```

MCP freshness flow:

```json
{
  "tool": "mem-import-latest",
  "args": {
    "projectPath": "/path/to/project",
    "sources": ["hermes", "codex"],
    "sessionLimit": 1,
    "messageLimit": 200,
    "processEmbeddings": false
  }
}
```

`mem-context-pack` also supports `refreshLatest: true` for explicit freshness and can auto-refresh narrow generic continuation queries when it has an absolute `projectPath`, no `sessionId` filter, and `refreshLatest` is not `false`. A read-only Hermes provider should pass `refreshLatest: false` so prefetch never mutates memory.

## Source-ref-preserving native compression

CML compression is native and source-ref preserving:

- `compression: "off" | "safe" | "aggressive"` controls LLM-facing preview compaction.
- `maxChars` and `maxTokens` bound final context-pack output.
- Raw CML events remain unchanged in storage.
- Source refs, citation IDs, session hints, and follow-up lookup instructions must survive compression.
- Privacy filtering runs before compression and final preview sanitization runs after compression.

Use `safe` as the normal mode. Use `aggressive` only when the caller explicitly prefers compactness over detail or when a benchmark proves it is acceptable for the task.

## Headroom stance

Headroom-style projects are useful references for compressing tool output, logs, diffs, JSON payloads, transcripts, and RAG chunks before an LLM call. CML should learn from those patterns, but should not install or require Headroom by default because CML must preserve:

- project scope and cross-agent provenance,
- event IDs and source refs,
- redaction and privacy gates,
- follow-up expansion paths through `mem-source-ref`,
- deterministic validation through tests and replay benchmarks.

If an external Headroom adapter is ever added, make it optional and non-default, for example behind an explicit `compressionEngine: "internal" | "headroom"` setting, and require parity tests that source refs and privacy redactions survive.

## Validation flows for boundary changes

For docs-only boundary updates:

```bash
git diff --check
npm run build || true
```

For changes touching CML context-pack, compression, retrieval, or MCP surfaces:

```bash
npm test -- --run tests/extensions/mcp-context-tools.test.ts tests/core/context-compressor.test.ts
npm run typecheck
npm run build
npm run eval:retrieval-replay
```

For Hermes provider changes, validate in the Hermes repository/plugin surface rather than adding CML runtime writes. The provider should remain read-only unless a separate product decision explicitly enables live sync.
