# Code Memory

A Claude Code plugin that learns from your conversations to provide personalized assistance. The more you use it, the smarter it gets.

## Features

- **Conversation Memory**: Stores user prompts and agent responses
- **Semantic Search**: Retrieves relevant memories using vector embeddings
- **AXIOMMIND Architecture**: Follows 7 principles for reliable memory management
- **Memory Graduation**: Promotes frequently-accessed memories through L0→L4 levels
- **Evidence Alignment**: Verifies that responses are grounded in actual memories

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code Hooks                       │
│  SessionStart │ UserPromptSubmit │ Stop │ SessionEnd        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Memory Service                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Retriever  │  │   Matcher   │  │  Graduation │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                      ▼
┌───────────────┐                    ┌───────────────┐
│  EventStore   │ ──── Outbox ────▶ │  VectorStore  │
│   (DuckDB)    │                    │   (LanceDB)   │
└───────────────┘                    └───────────────┘
```

## AXIOMMIND Principles

1. **Single Source of Truth**: DuckDB EventStore is authoritative
2. **Append-Only**: Events are never modified or deleted
3. **Idempotency**: Duplicate events detected via dedupe_key
4. **Evidence Alignment**: Verify claims against source content
5. **Entity-Based Tasks**: Canonical keys for consistent identification
6. **Vector Store Consistency**: Unidirectional DuckDB → LanceDB flow
7. **Standard JSON**: All data in portable JSON format

## Installation

```bash
npm install
npm run build
```

## Usage

### Hooks

The plugin automatically hooks into Claude Code sessions:

- **SessionStart**: Loads relevant project context
- **UserPromptSubmit**: Retrieves memories for the prompt
- **Stop**: Stores agent responses
- **SessionEnd**: Generates session summary

### Commands

```bash
# Search memories
/memory-search "how to implement authentication"

# View history
/memory-history --limit 50

# View statistics
/memory-stats

# Forget memories
/memory-forget --session <id> --confirm
```

### CLI

```bash
# Search
npx code-memory search "React patterns"

# History
npx code-memory history --limit 20

# Stats
npx code-memory stats

# Process embeddings
npx code-memory process
```

## Memory Levels

| Level | Name | Description |
|-------|------|-------------|
| L0 | EventStore | Raw events (append-only) |
| L1 | Structured | Session summaries, patterns |
| L2 | Candidates | Validated type schemas |
| L3 | Verified | Cross-session validated |
| L4 | Active | Indexed, readily searchable |

## Matching Thresholds

| Confidence | Score | Gap | Action |
|------------|-------|-----|--------|
| High | ≥0.92 | ≥0.03 | Auto-use memory |
| Suggested | ≥0.75 | <0.03 | Show alternatives |
| None | <0.75 | - | No match |

## Configuration

Memory is stored in `~/.claude-code/memory/` by default:

```
~/.claude-code/memory/
├── events.duckdb     # Event store
└── vectors/          # LanceDB vectors
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Type check
npm run typecheck
```

## License

MIT
