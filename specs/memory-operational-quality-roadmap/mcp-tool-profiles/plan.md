# MCP Tool Profiles Plan

> **State**: Incubating
> **Suggested release**: Minor

## Entry gate

Capture the exact current tool list, serialized schema bytes/hash, handler parity, and mutation behavior on latest `origin/main`.

## Packet 1 — Registry without behavior change

1. Define registry types and mutation predicates.
2. Generate/list tools and dispatch from the registry.
3. Add duplicate/missing/parity tests.
4. Preserve `all` output exactly.

## Packet 2 — Handler extraction

1. Extract one bounded domain per commit.
2. Preserve presenters, errors, privacy, and service lifecycle.
3. Run focused parity/golden tests after every extraction.

## Packet 3 — Opt-in profiles

1. Assign profile metadata and define `core` contents.
2. Add environment/config selection with `all` default.
3. Add schema budget and conditional-mutation tests.
4. Document migration and troubleshooting.

## Suggested commits

- `refactor(mcp): route tools through bounded registry modules`
- `feat(mcp): add backward-compatible tool profiles`

## Progress

No implementation started; baseline capture is the next action.
