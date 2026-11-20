# /memory-layer:memory-list

List available Claude Code sessions that can be imported.

## Usage

```
/memory-layer:memory-list [options]
```

## Options

- `--project <path>`: Filter sessions by project path

## Examples

```
/memory-layer:memory-list
/memory-layer:memory-list --project /home/user/myproject
```

## Description

Shows all available Claude Code session files that can be imported into memory. Each session displays:

- **Session ID**: Unique identifier for the session
- **Modified date**: When the session was last updated
- **File size**: Size of the session file
- **Path**: Full path to the JSONL file

Use this command to identify which sessions you want to import before running `/memory-layer:memory-import`.

## Implementation

```bash
claude-memory-layer list $ARGUMENTS
```
