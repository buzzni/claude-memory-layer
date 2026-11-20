# /memory-layer:memory-import

Import existing Claude Code conversation history into memory.

## Usage

```
/memory-layer:memory-import [options]
```

## Options

- `--project <path>`: Import from specific project path
- `--session <file>`: Import a specific session file (JSONL)
- `--all`: Import all sessions from all projects
- `--limit <n>`: Limit messages per session
- `--verbose`: Show detailed progress

## Examples

```
/memory-layer:memory-import
/memory-layer:memory-import --project /home/user/myproject
/memory-layer:memory-import --all
/memory-layer:memory-import --session ~/.claude/projects/xyz/abc123.jsonl
/memory-layer:memory-import --all --limit 100 --verbose
```

## Description

This command imports existing Claude Code conversation history from JSONL session files into the memory store. This allows the plugin to learn from your previous conversations and provide more relevant context in future sessions.

### What gets imported:

- **User prompts**: Your questions and requests
- **Agent responses**: Claude's responses (truncated to 5000 chars)
- **Session metadata**: Timestamps and session IDs

### Deduplication

The importer automatically skips duplicate messages based on content hash, so you can safely run import multiple times without creating duplicate memories.

### Session Files Location

Claude Code stores session history in:
```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

Use `/memory-layer:memory-list` to see available sessions before importing.

## Implementation

Run this command with the Bash tool and report its output:

```bash
claude-memory-layer import $ARGUMENTS
```
