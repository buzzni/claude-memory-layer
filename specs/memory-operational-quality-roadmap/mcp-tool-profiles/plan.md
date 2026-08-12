# MCP Tool Profiles Plan

> **State**: Implementation ready for review
> **Suggested release**: Minor

## Entry gate

Capture the exact current tool list, serialized schema bytes/hash, handler parity, and mutation behavior on latest `origin/main`.

Captured from `origin/main` at `9810c194e4c4f4f77d935a0878196845e9e7bc08`:

- 44 tools,
- 47,622 serialized JSON bytes,
- SHA-256 `f3e05cbf821dddc04b038ec02aeee7cc567092261bcb0ae16bf5bba824c445c1`,
- `handleToolCall` compatibility behavior covered by the existing MCP context, operation, perspective, shared, project-aware, and privacy suites.

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

- Packet 1 implemented: generated registry owns schema references, handlers, profiles, and mutation metadata; exact `all` parity is regression-tested.
- Packet 2 implemented: canonical server dispatch uses six bounded handler domains while `handleToolCall` remains a compatibility entrypoint.
- Packet 3 implemented: opt-in environment selection, `all` default, 7-tool/8,694-byte `core`, mutation predicates, migration guidance, and rollback troubleshooting.
- Merge, minor-version release, and post-install client smoke remain rollout work; this document does not mark the feature fully complete before those steps.
