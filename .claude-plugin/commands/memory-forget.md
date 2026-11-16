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
3. With `--before` only, removes the whole dated files of the store's markdown mirror under `~/.claude-code/memory`

If vectors could not be removed, the command prints a warning; with `event-id` or `--session` it also exits 1, while `--before` only warns.

`event-id` and `--session` do not clean the store's markdown mirror or the second mirror written under the project directory (`<project>/memory/`), so forgotten text can remain in both (#274, #276). `--before` does not clean the project directory's mirror either.

⚠️ **Note**: Deletion is permanent. Only `--before` runs `VACUUM`; after deleting a single event or session, freed database pages are reused but the file does not shrink until a later vacuum.

## Implementation

```bash
claude-memory-layer forget $ARGUMENTS
```
