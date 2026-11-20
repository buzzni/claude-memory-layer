# /memory-layer:memory-stats

View memory storage statistics.

## Usage

```
/memory-layer:memory-stats
```

## Description

Displays statistics about stored memories including:

- Total number of events
- Number of vector embeddings
- Memory level distribution (L0-L4)
- Storage size information

## Memory Levels

The graduation pipeline moves memories through these levels:

- **L0**: Raw events (EventStore)
- **L1**: Structured JSON (patterns, summaries)
- **L2**: Type candidates (validated schemas)
- **L3**: Verified knowledge (cross-session validated)
- **L4**: Active/searchable (indexed, readily available)

## Implementation

Run this command with the Bash tool and report its output:

```bash
claude-memory-layer stats
```
