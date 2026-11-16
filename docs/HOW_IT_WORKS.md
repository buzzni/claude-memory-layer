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
| PreToolUse | Edit tools only, off unless `preEditCheck` is enabled: before a file is edited, adds what earlier sessions left about it ([below](#pre-edit-check)) |
| Stop | Stores the assistant's response |
| SessionEnd | Finishes the session (summary and storage) |

## Compaction checkpoint

Right before Claude Code compacts the conversation (manually or automatically), the PreCompact hook saves where the session stood as a checkpoint: the last 3 requests, the latest response, and up to 10 files inside the project that the session recently edited (Write, Edit, MultiEdit, NotebookEdit). It reads only stored events and never calls an LLM, because it runs on the compaction's critical path. It is stored with the other checkpoints (`memory_checkpoints`) in the project store; a project without a store gets none.

The hook always prints nothing, since its output would become instructions for the compaction summary, and it exits 0 on any error, so compaction always proceeds.

When the compaction finishes, SessionStart runs with source `compact` and puts the checkpoint back first, as a "Before Compaction" section. Events the checkpoint quotes are left out of the recent-memory recap, so nothing is injected twice. A checkpoint older than 10 minutes is ignored, because it belongs to an earlier compaction.

## Pre-edit check

With `preEditCheck.enabled` in `operations.json`, the PreToolUse hook runs before Write, Edit, MultiEdit and NotebookEdit and adds a short "Memory About <file>" note next to the tool result. It lists up to 3 lessons linked to the file (built from an edit of it, or naming its project-relative path), up to 2 failed tool runs on it, and summaries of up to 3 sessions that edited it (Write, Edit, MultiEdit or NotebookEdit; a session that only read the file is not listed). The current session's own edits, summary and lessons are left out.

**What it searches.** Every read is capped so the hook finishes in bounded time on any store. Memories outside these windows are not looked for:

- the newest 2000 tool observations, skipping any larger than 64 KiB;
- with codify-lite, the newest 50 `touched_in` links of the file;
- the newest 500 session summaries, for the sessions found above;
- up to 500 lessons of the project.

It reads only the project store, never calls an LLM or the semantic daemon, and waits at most 200 ms for a lock.

**Which file.** The file and the project directory are compared by real path (symlinks resolved, the case the filesystem stores, and for a file not created yet, its nearest existing directory), so `src/../src/a.ts`, a symlinked path and a case alias on a case-insensitive filesystem are the same file, and a path that leads out of the project through a symlink gets nothing.

**"(file changed since)".** A note is marked only when the file certainly changed after it was recorded: the file's modification time, cut to whole milliseconds, is later than the note's time (a summary's own time, a failed run's time, a lesson's last update). Coarse filesystem timestamps only round down, so the mark is never added wrongly by them; it can be missing for a change in the same millisecond, or when the system clock was set back between the note and the change.

**What it shows.** Paths inside the project are shown relative to it, and any other absolute path in stored text becomes `[path]`; stored text goes through the privacy filter and the output sanitizer. The note is capped at 1500 characters as it leaves the sanitizer; what does not fit can appear on a later edit of the file. Nothing found means no output.

**Not repeating itself.** An item shown for a file is not shown again for that file in the same session. Each shown item is reserved by creating an empty marker file exclusively under `projects/<hash>/pre-edit-check/<session>/`, so parallel edits in one session show it once. That costs one empty file per item shown. A session's markers are deleted 7 days after the last run in that session that found notes, by the first run of another session.

**Known limit.** Failed tool calls are mostly missing from the store until PostToolUseFailure is captured ([#222](https://github.com/buzzni/claude-memory-layer/issues/222)): PostToolUse records a call as failed only when it was interrupted. Until then the failed-runs list is almost always empty.

**Cost.** The hook never blocks the edit: it returns no permission decision, and on any error, timeout or missing store it prints nothing and exits 0. It is always registered; while the flag is off its entry exits before loading SQLite (about 3–5 ms over a bare Node start of 26 ms, measured on macOS). When on, a run takes about 105–115 ms including Node start, on a store with 300,000 summaries and 200,000 links to the file; when the 2000 newest observations are all just under 64 KiB, about 300 ms.

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
