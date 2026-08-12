# MCP Tool Profiles

Claude Memory Layer exposes selectable MCP tool profiles without removing any canonical tool. During the compatibility period, an unset profile selects `all`, which preserves the original 44-tool list, ordering, schemas, and dispatch behavior.

## Selecting a profile

Set `CLAUDE_MEMORY_MCP_PROFILE` in the MCP server process environment:

```json
{
  "mcpServers": {
    "claude-memory-layer": {
      "command": "claude-memory-layer-mcp",
      "args": [],
      "env": {
        "CLAUDE_MEMORY_MCP_PROFILE": "core"
      }
    }
  }
}
```

Restart the MCP client after changing the setting. A missing or blank value selects `all`. An unknown value stops server startup with the accepted profile names instead of silently falling back.

## Profiles

| Profile | Intended surface |
|---|---|
| `core` | Seven context/search/source-navigation tools; 8,694 serialized schema bytes at the introduction baseline |
| `operations` | `core` plus explicit import, facets, actions, frontier, checkpoints, and retention audit |
| `governance` | `core` plus assets, actors, core-memory blocks, and shared-memory governance |
| `experimental` | `core` plus market context, graph/lesson tools, entity supersession, and perspective tools |
| `all` | Every canonical tool; compatibility default |

Profiles only limit advertised and dispatchable MCP tools. They do not delete data, unregister functionality, or change the behavior of a tool that remains visible.

## Mutation classification

The registry classifies every tool as `read_only`, `conditional`, or `mutating`.

- `mem-context-pack` is conditional. `refreshLatest: true` writes imported history. Generic continuation queries also auto-refresh when an absolute `projectPath` is supplied and no `sessionId` filter is present. Use `refreshLatest: false` for the read-only refresh opt-out. Successful retrieval may still record the already-documented best-effort query telemetry.
- `mem-asset-catalog-sync` is conditional. Its default and `apply: false` are previews; `apply: true` creates missing catalog assets.
- `mem-import-latest` and explicit state-changing operation/governance tools are mutating.

Conditional registry entries expose a machine-readable expression, defaults, a read-only opt-out, and the same predicate used by registry inspection tests.

## Troubleshooting and rollback

- `Unknown MCP tool profile`: correct or remove `CLAUDE_MEMORY_MCP_PROFILE`, then restart the client.
- A tool disappeared after selecting a smaller profile: select the matching domain profile or restore `all`.
- A client cached the previous schema: restart the client/MCP server so it requests the tool list again.
- Rollback requires only removing the environment variable; no memory migration is involved.
