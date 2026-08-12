# MCP Tool Profiles Specification

> **Status**: Incubating

## Requirements

### MCP-001 — Registry parity

A single registry/generated mapping owns tool name, description, schema, handler, profiles, and mutation classification. Tests fail for duplicate, missing, or unhandled entries.

### MCP-002 — Mutation predicates

Classification supports `read_only`, `conditional`, and `mutating`. Conditional entries expose machine-readable write predicates/defaults for auto-refresh and preview/apply behavior.

### MCP-003 — Bounded handlers

Extract handlers by domain—context/search, source/import, operations, graph/lessons, governance/assets, perspective/shared—while preserving the compatibility `handleToolCall` path and public output.

### MCP-004 — Profiles

Support `core`, `operations`, `governance`, `experimental`, and `all`. Environment/config selection is sufficient initially; per-client negotiation is optional.

### MCP-005 — Core budget

`core` contains at most 10 tools and at most 20 KB serialized schema. It includes context/search/source navigation and project timeline/stats, excludes always-mutating explicit import, and identifies context-pack auto-refresh as conditional with a read-only opt-out.

### MCP-006 — Compatibility

`all` remains the default for the compatibility period and retains the prior list/schema/behavior. Profile changes do not remove canonical functionality.

## Acceptance

- Exact pre/post `all` registry names, schema hashes/bytes, and critical behavior match.
- Every conditional tool has tested true/false mutation predicates.
- `core` meets count/schema budgets.
- Unknown profile fails clearly; missing configuration selects `all`.
- Context pack, import latest, source ref, frontier, graph, and governance smoke tests pass.

## Non-goals

- removing tools in the first profile release,
- changing tool response semantics during handler extraction,
- adding remote transport or per-client negotiation as a prerequisite.
