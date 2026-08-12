# MCP Tool Profiles Context

> **Status**: Incubating
> **Parent**: [`../spec.md`](../spec.md)

## Problem

The inspected MCP server exposed 44 tools with roughly 47,622 bytes of serialized schema—about 11,900 tokens by a coarse four-characters-per-token estimate. Tool definitions and handling are concentrated in large source files, increasing client context cost and making mutation safety harder to audit.

Several advanced surfaces had little or no observed data, while context/search/source navigation are routinely used. This supports selectable profiles, not immediate tool removal.

## Compatibility constraints

- `all` initially exposes the existing tool list/schema behavior.
- `src/mcp` remains a compatibility entrypoint while canonical implementation lives under `src/extensions/mcp`.
- Registry refactoring must be behavior-preserving before profile selection changes visibility.
- Mutation is not binary: `mem-context-pack` may auto-refresh, and preview/apply tools mutate only for specific inputs. Metadata needs `read_only`, `conditional`, and `mutating`.

## Relevant code

- `src/extensions/mcp/tools.ts`
- `src/extensions/mcp/handlers.ts`
- `src/extensions/mcp/index.ts`
- `src/mcp/` compatibility shims
- MCP tool/operation/privacy test suites
