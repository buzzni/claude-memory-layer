# /memory-forget

Remove specific memories from storage.

## Usage

```
/memory-forget <event-id>
/memory-forget --session <session-id>
/memory-forget --before <date>
```

## Arguments

- `event-id`: Specific event ID to forget
- `--session <id>`: Forget all events from a session
- `--before <date>`: Forget events before a date (YYYY-MM-DD)
- `--confirm`: Skip confirmation prompt

## Examples

```
/memory-forget abc123-def456
/memory-forget --session session_xyz --confirm
/memory-forget --before 2024-01-01
```

## Description

Removes memories from storage. This operation:

1. Marks events as deleted in EventStore (soft delete)
2. Removes corresponding vectors from LanceDB
3. Updates memory level statistics

⚠️ **Note**: Due to the append-only architecture, deleted events are marked but not physically removed from the event log. Vector embeddings are physically deleted.

## Implementation

```bash
node dist/cli/index.js forget $ARGUMENTS
```
