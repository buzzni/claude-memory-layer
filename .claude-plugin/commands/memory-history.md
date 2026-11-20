# /memory-layer:memory-history

View conversation history from memory.

## Usage

```
/memory-layer:memory-history [options]
```

## Options

- `--session <id>`: Show history for a specific session
- `--limit <n>`: Limit number of events (default: 20)
- `--type <type>`: Filter by event type (user_prompt, agent_response, session_summary)

## Examples

```
/memory-layer:memory-history
/memory-layer:memory-history --limit 50
/memory-layer:memory-history --session abc123
/memory-layer:memory-history --type user_prompt
```

## Description

Displays stored conversation events from memory. By default shows the most recent events across all sessions. Use filters to narrow down to specific sessions or event types.

## Implementation

Run this command with the Bash tool and report its output:

```bash
claude-memory-layer history $ARGUMENTS
```
