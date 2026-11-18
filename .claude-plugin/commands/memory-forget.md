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
- `--session <id>`: Forget every event of a session (hook, import and summary rows alike)
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

1. Deletes the matching events, their dependent rows and pending embedding jobs from SQLite, and writes one `event_delete` governance audit row (scope and counts, no content) in the same transaction
2. Removes the vectors of the deleted events from LanceDB
3. Removes their entries from the store's markdown mirror under `~/.claude-code/memory` (`--before` removes whole dated mirror files)

If a vector or mirror entry could not be removed, the command prints a warning and exits 1.

The second markdown mirror written under the project directory (`<project>/memory/`) is not cleaned, so forgotten text can remain there (#274).

⚠️ **Note**: Deletion is permanent. Only `--before` runs `VACUUM`; after deleting a single event or session, freed database pages are reused but the file does not shrink until a later vacuum.

## Implementation

```bash
node dist/cli/index.js forget $ARGUMENTS
```
