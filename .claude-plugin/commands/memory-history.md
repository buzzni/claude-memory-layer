# /memory-history

View conversation history from memory.

## Usage

```
/memory-history [options]
```

## Options

- `--session <id>`: Show history for a specific session
- `--limit <n>`: Limit number of events (default: 20)
- `--type <type>`: Filter by event type (user_prompt, agent_response, session_summary)

## Examples

```
/memory-history
/memory-history --limit 50
/memory-history --session abc123
/memory-history --type user_prompt
```

## Description

Displays stored conversation events from memory. By default shows the most recent events across all sessions. Use filters to narrow down to specific sessions or event types.

## Implementation

```bash
node dist/cli/index.js history $ARGUMENTS
```
