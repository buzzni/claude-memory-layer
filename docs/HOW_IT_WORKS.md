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
| PostToolUseFailure | Stores a tool call that failed while running, as a tool observation with `success: false` and the error text ([below](#failed-tool-calls)) |
| PreCompact | Saves a checkpoint of where the session stood right before Claude Code compacts the context ([below](#compaction-checkpoint)) |
| PreToolUse | Edit tools only, off unless `preEditCheck` is enabled: before a file is edited, adds what earlier sessions left about it ([below](#pre-edit-check)) |
| Stop | Stores the assistant's response |
| SessionEnd | Finishes the session (summary and storage) |

## Failed tool calls

Claude Code reports a tool call that started and then failed to PostToolUseFailure, never to PostToolUse, so each call reaches one of the two. PostToolUseFailure stores it as a tool observation with `success: false`; the `error` text Claude received is both its output and its error message. It goes through what PostToolUse applies: the same tools are left out (including `CLAUDE_MEMORY_TOOL_BLOCKLIST`), the [capture policy](CONFIGURATION.md#capture-policy), the privacy filter (credentials, `<private>` sections) and truncation. PostToolUse's output-length filter does not apply, since a failure is often one line (`Exit code 1`). Like PostToolUse, it decides before loading SQLite and never blocks: on any error it stores nothing and the tool flow goes on.

What reaches it, checked with Claude Code 2.1.325: a Bash command that exits non-zero (`Exit code N` plus its output) and a file edit that fails while writing (for example `EACCES`); by the hooks reference, also an MCP tool that returns an error. What does not: a call Claude Code rejects before running it, such as an Edit whose `old_string` is not in the file or input that fails validation. That rejection fires no hook at all, so it is not stored. A call cancelled while running reaches PostToolUse with `interrupted`, as before.

An install made before this hook existed gets it by running `claude-memory-layer install` again; `claude-memory-layer doctor` names it while it is missing. The plugin picks it up when it updates.

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

**What it shows.** Paths inside the project are shown relative to it, and any other absolute path in stored text becomes `[path]`; stored text goes through the privacy filter and the output sanitizer. Each item carries the [source trust label](#source-trust-labels) of the row it quotes, ahead of any stored text: a failed run is tool output (or unknown origin when its row is not a tool observation), a summary pulled from another machine is imported. The note is capped at 1500 characters as it leaves the sanitizer; what does not fit can appear on a later edit of the file. Nothing found means no output.

**Not repeating itself.** An item shown for a file is not shown again for that file in the same session. Each shown item is reserved by creating an empty marker file exclusively under `projects/<hash>/pre-edit-check/<session>/`, so parallel edits in one session show it once. That costs one empty file per item shown. A session's markers are deleted 7 days after the last run in that session that found notes, by the first run of another session.

**Known limit.** Failed runs come from [PostToolUseFailure](#failed-tool-calls), which sees an edit only when it fails while writing (for example `EACCES`). The most common failed edit, an `old_string` that is not in the file, is rejected before the tool runs and fires no hook, so it never appears here.

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

### Source trust labels

Every recalled memory is classified by where its text came from (`src/core/memory-origin.ts`). The class is derived from the event type and metadata every row already has, so old rows are classified too; nothing extra is stored.

**Metadata can only lower trust.** The class starts from the stored row's own `event_type` column (or the lesson table), never from a type or id written into metadata: metadata is written by whatever stored the row, tool output included. Provenance markers in metadata can only move a row down (to `imported` or `unknown`); none moves it up. When the origin cannot be confirmed (no stored row to read, an unknown type, metadata that is not an object, a marker of the wrong shape such as `"mongoSync": "yes"`) the class is `unknown`.

**Computed once, where the row is read.** The store classifies a row when it reads it from SQLite, from the raw `event_type` and `metadata` columns, and carries the class on the row (`MemoryEvent.origin`); the endless-mode working set and the pre-edit check, which read rows with their own SQL, do the same. Disclosure results, hooks, MCP and the CLI pass that value on and never classify again: by then unreadable metadata has been dropped and would look like a row with none. A memory that did not come through the store has no class and is `unknown`. Semantic search results are looked up in the store too: the hook uses the stored row's type, text and class, and the daemon's own report can only lower the class (a hit whose row cannot be read is shown as type `unknown`, origin `unknown`). That adds up to 5 primary-key reads per prompt, about 1.5 ms in a fresh hook process on a 2.2 GB store. A test pins where classification may happen.

| Origin | Rows | Label |
|---|---|---|
| `user` | `user_prompt`, from a live hook or a host session import | none |
| `assistant` | `agent_response`, from a live hook or a host session import | none |
| `derived` | `session_summary` and lessons (text this system wrote from stored rows) | none |
| `imported` | any other row pulled by Mongo sync (from another machine), or imported from a source that cannot be told (a string `metadata.importedFrom` that is not an absolute path) | `low-trust: imported` |
| `tool` | `tool_observation` (tool input and output), however it was stored | `low-trust: tool output` |
| `unknown` | anything whose origin cannot be confirmed: another event type, unreadable metadata or provenance marker, a result with no stored row | `low-trust: unknown origin` |

**Host session imports keep their role.** This is not metadata raising trust: an absolute-path `importedFrom` is only the condition under which it does not lower the row to `imported`. `claude-memory-layer import` (Claude Code sessions), the Codex SessionEnd hook (every Codex session is captured this way) and the Hermes import read this machine's own host session records from a path the user configured, and store that path in `metadata.importedFrom`. They are trusted like a live capture: a prompt is `user`, a response `assistant`, a tool call `tool`. Every importer version has stored an absolute path there, which is how old rows are recognised too. Labelling them would put a low-trust label on every memory of a Codex user, and a label on everything means nothing. Limit: a session file copied from another machine and imported locally cannot be told apart from a local one.

**Mongo sync pull marks every pulled row** with a `metadata.mongoSync` record (pull never returns this store's own rows), so a memory from another machine is `imported`. Before this marker, only rows re-homed from another project hash got the record; rows pulled earlier within the same project hash carry no marker and classify by their role.

Only the low-trust classes are labelled, so the common case costs no extra tokens. The label sits outside the memory text, next to the type: `- [tool_observation] [low-trust: tool output] …` in the prompt-time evidence block, `- **date** [low-trust: imported]: …` in the SessionStart recap, `(agent_response; low-trust: imported)` on a reference card, `- [low-trust: tool output] Edit on this file failed …` in the [pre-edit check](#pre-edit-check), after the type in `mem-search` and `mem-timeline`, as `Last [low-trust: …]:` on the recent sessions of `mem-context-pack` and `mem-project-timeline`, after the type in CLI `search` and `search --disclosure` (a shared cross-project entry there has no stored row here and shows as unknown origin), and after the type in the endless-mode working set (CLI `endless working-set` and the endless context). Field-style MCP output always carries the class: `origin=…` on `mem-context-pack` memory lines and `mem-source-ref` neighbors, and `Origin:` in `mem-details` and `mem-source-ref`.

Graduation does not change the class. A memory graduates by being retrieved, and an injected memory is retrieved again by being injected, so trusting graduated rows would let a poisoned row earn trust just by being recalled. Summaries and lessons stay `derived` even though they can restate tool output.

Operators can keep `tool` and `unknown` rows out of automatic injection (SessionStart, UserPromptSubmit and the pre-edit check, including the Codex hooks) with an [`operations.json` flag](CONFIGURATION.md#optional-features-operationsjson). The filter runs before ranking, so trusted memories can take the freed slots; tool rows still seed the same-turn episode lookup, which then injects that turn's answer. Because ranking (including its score cliff) runs on what is left, the injection with the flag on is **not** a subset of the injection with it off: removing a tool row can let another memory in or change where the cut falls. Requested reads (MCP tools, CLI `search`) are never filtered, only labelled. The PreCompact re-injection quotes only the session's own prompts and response plus file paths from its own edit-tool calls, so it is not filtered either. In the pre-edit check the filter drops the failed tool runs: what they quote is the tool's error message, and the lessons and session summaries still give the file's history.

Hook traces record how many injected memories each class had (`injectedByOrigin` in the trace diagnostics; counts only): the UserPromptSubmit evidence, the SessionStart recap and the SessionStart lesson index (lessons count as `derived`). Core memory blocks, the compaction checkpoint and the pre-edit check write no such trace and are not counted. `memory-audit` sums the counts per store, so the flag's reach can be checked before turning it on. `npm run eval:hook-replay` replays a store copy with the filter on as its `source-trust filter` arm; `benchmarks/replay/hook-grounding-source-trust-v1.json` is a small fixture where the filter has something to remove (tool output next to an answer, a graduated tool row, an unknown-origin row, and a tool row whose metadata claims `agent_response`).

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
