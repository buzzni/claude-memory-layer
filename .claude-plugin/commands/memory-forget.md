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
- `--type <event-type>`: With `--before`, only this event type
- `--confirm`: Apply the deletion (without it, only a preview is shown)

Use exactly one of `event-id`, `--session` or `--before`.

## Examples

```
/memory-forget abc123-def456
/memory-forget --session session_xyz --confirm
/memory-forget --before 2024-01-01
```

## Description

Without `--confirm` the command only reports what matches and deletes nothing. With `--confirm` it:

1. Deletes the matching events and their dependent rows from SQLite
2. Removes the corresponding vectors from LanceDB
3. Removes the markdown mirror entries (`--before` removes whole dated mirror files)

⚠️ **Note**: Deletion is permanent. Only `--before` runs `VACUUM`; after deleting a single event or session, freed database pages are reused but the file does not shrink until a later vacuum.

## Implementation

```bash
node dist/cli/index.js forget $ARGUMENTS
```
