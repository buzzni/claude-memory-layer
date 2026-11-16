# How It Works

[← README](../README.md)

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agent surfaces                                                       │
│ Claude Code Hooks │ CLI │ Dashboard │ MCP Clients │ Codex/Hermes import │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Memory Service / Runtime                                             │
│ Retrieval Orchestrator │ Disclosure │ Operations │ Perspective Memory │
│ Evidence/Privacy filters │ Governance audit │ Context-pack assembler │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
┌──────────────────┐   ┌──────────────────┐   ┌───────────────────────┐
│ SQLite EventStore│   │ Operations tables│   │ External read-only ctx │
│ events/sessions  │   │ facets/actions/  │   │ DART/FRED/Finnhub     │
│ actor/perspective│   │ checkpoints/...  │   │                       │
└─────────┬────────┘   └──────────────────┘   └───────────────────────┘
          │ same transaction
          ▼
┌──────────────────┐      worker lock/recovery      ┌──────────────────┐
│ Vector Outbox V2 │ ─────────────────────────────▶ │ LanceDB vectors  │
│ itemKind/id/ver  │   versioned delete+add upsert  │ per item/version │
└──────────────────┘                                └──────────────────┘
```

SQLite is the canonical source of truth and LanceDB is a derived accelerator that can be rebuilt. Every vector write goes through the outbox and is idempotent. MCP, dashboard and CLI output is limited to aggregates or redacted previews where possible.

## Hooks

| Hook | What it does |
|---|---|
| SessionStart | Loads project context for the new session |
| UserPromptSubmit | Stores the prompt and searches related memories to inject |
| PostToolUse | Stores tool observations (tool input and output) |
| PreCompact | Saves a checkpoint of where the session stood right before Claude Code compacts the context ([below](#compaction-checkpoint)) |
| Stop | Stores the assistant's response |
| SessionEnd | Finishes the session (summary and storage) |

## Compaction checkpoint

Right before Claude Code compacts the conversation (manually or automatically), the PreCompact hook saves where the session stood as a checkpoint: the last 3 requests, the latest response, and up to 10 files inside the project that the session recently edited (Write, Edit, MultiEdit, NotebookEdit). It reads only stored events and never calls an LLM, because it runs on the compaction's critical path. It is stored with the other checkpoints (`memory_checkpoints`) in the project store; a project without a store gets none.

The hook always prints nothing, since its output would become instructions for the compaction summary, and it exits 0 on any error, so compaction always proceeds.

When the compaction finishes, SessionStart runs with source `compact` and puts the checkpoint back first, as a "Before Compaction" section. Events the checkpoint quotes are left out of the recent-memory recap, so nothing is injected twice. A checkpoint older than 10 minutes is ignored, because it belongs to an earlier compaction.

## Storing a memory

```
user prompt
    ↓
EventStore (SQLite/WAL, append-only)
    ↓
embedding job queued in the outbox (same transaction)
    ↓
vector worker computes the embedding
    ↓
VectorStore (LanceDB)
```

Each event has a `dedupe_key`, so the same content in the same session is stored once.

## Retrieving memories

For each prompt the UserPromptSubmit hook runs a search over the project store (`CLAUDE_MEMORY_RETRIEVAL_MODE`, default `hybrid`: keyword plus semantic), keeps results at or above `CLAUDE_MEMORY_MIN_SCORE` (default 0.4) and retries with `CLAUDE_MEMORY_FALLBACK_MIN_SCORE` (0.3) when nothing matched. See [CONFIGURATION.md](CONFIGURATION.md#recall-tuning-claude-code-hooks).

### Match confidence

The retriever also classifies its top match. It drives fallback and the context header; the hook does not use it to decide whether to inject.

| Confidence | Top score | Gap to second |
|---|---|---|
| High | ≥ 0.92 | ≥ 0.03 |
| Suggested | ≥ 0.75 | |
| None | < 0.75 | |

### Progressive disclosure

Search returns a compact index first. A timeline around a result, and then full details, are loaded only for the items you pick (`search --disclosure` → `expand` → `source` in the CLI; `mem-search` → `mem-timeline` → `mem-details` in MCP).

### Citations

Context injected by the hooks and MCP results cite memories as `[mem:abc123]`. The MCP `mem-source-ref` tool resolves a citation to a redacted preview and safe metadata, optionally with the neighboring events of the same session.

## Graduation

`process` runs one bounded graduation pass that promotes memories through levels. A memory moves up when it meets all criteria of the step and is not older than its age limit:

| Step | Accesses | Confidence | Cross-session refs | Max age |
|---|---|---|---|---|
| L0 EventStore → L1 Structured | ≥ 1 | ≥ 0.5 | 0 | 30 days |
| L1 → L2 Candidates | ≥ 3 | ≥ 0.7 | ≥ 1 | 60 days |
| L2 → L3 Verified | ≥ 5 | ≥ 0.85 | ≥ 2 | 90 days |
| L3 → L4 Active | ≥ 10 | ≥ 0.92 | ≥ 3 | 180 days |

## Entity-edge model

```
┌─────────────────────────────────────────────────────────────┐
│                        edges                                 │
│  ┌──────────┐    evidence_of    ┌──────────┐               │
│  │  Entry   │ ─────────────────▶│  Entity  │               │
│  │ (Fact,   │                   │ (Task,   │               │
│  │ Decision)│                   │ Artifact)│               │
│  └──────────┘                   └──────────┘               │
│       │                              │                       │
│       │ derived_from                 │ blocked_by           │
│       ▼                              ▼                       │
│  ┌──────────┐                   ┌──────────┐               │
│  │  Entry   │                   │  Entity  │               │
│  └──────────┘                   └──────────┘               │
└─────────────────────────────────────────────────────────────┘
```

## Design principles (AXIOMMIND)

1. **Single source of truth**: the SQLite/WAL EventStore
2. **Append-only**: events are added, not edited
3. **Idempotency**: `dedupe_key` detects duplicate events
4. **Evidence alignment**: claims are checked against their source
5. **Entity-based tasks**: `canonical_key` identifies entities consistently
6. **Vector store consistency**: one-way flow from the SQLite outbox to LanceDB
7. **Standard JSON**: portable JSON data

## Storage layout

```
~/.claude-code/memory/
├── projects/<hash>/events.sqlite  # per-project event store (primary)
├── projects/<hash>/vectors/       # per-project vector index (LanceDB)
├── models/                        # local embedding model cache
├── operations.json                # optional feature flags
└── shared/                        # optional shared knowledge store
```

Claude Code itself keeps session transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`; `import` reads them from there.

## Tech stack

- **SQLite / WAL**: event store (canonical append/read model)
- **LanceDB**: vector store (derived acceleration index)
- **@huggingface/transformers**: local embeddings (lazy import; the embedder lives in `src/extensions/vector/`)
- **Zod**: runtime validation
- **Commander**: CLI
- **TypeScript**
- **Node.js + Hono**: HTTP server and dashboard
- **MCP SDK**: the `claude-memory-layer-mcp` stdio server

## Design documents

Detailed specs live in [`specs/`](../specs):

| Spec | Topic |
|---|---|
| [memory-utilization-improvements/2026-08-31-audit](../specs/memory-utilization-improvements/2026-08-31-audit/README.md) | MCP read-only, scope, retrieval, vector, retention, telemetry |
| [agentmemory-inspired-memory-operations](../specs/agentmemory-inspired-memory-operations/spec.md) | Facets, actions, frontier, checkpoints, retention, lessons |
| [honcho-inspired-peer-context-memory](../specs/honcho-inspired-peer-context-memory/spec.md) | Actor cards, perspective observations |
| [vector-outbox-v2](../specs/vector-outbox-v2/spec.md) | Transactional outbox, versioned vector upsert, worker recovery |
| [mcp-desktop-integration](../specs/mcp-desktop-integration/spec.md) | MCP server |
| [progressive-disclosure](../specs/progressive-disclosure/spec.md) | Progressive disclosure search |
| [citations-system](../specs/citations-system/spec.md) | Memory citations |
| [private-tags](../specs/private-tags/spec.md) | Privacy tags |
| [entity-edge-model](../specs/entity-edge-model/spec.md) | Three-layer data model |
| [task-entity-system](../specs/task-entity-system/spec.md) | Task entities |
| [evidence-aligner-v2](../specs/evidence-aligner-v2/spec.md) | Evidence alignment |
| [post-tool-use-hook](../specs/post-tool-use-hook/spec.md) | Tool observation capture |
| [endless-mode](../specs/endless-mode/spec.md) | Endless Mode |
| [web-viewer-ui](../specs/web-viewer-ui/spec.md) | Dashboard |

Architecture comparisons with other memory projects: [architecture/comparison-index.md](architecture/comparison-index.md).
