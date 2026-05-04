# Test Matrix

The test suite mirrors the thin-core architecture so regressions are easier to localize.

- `core/` — core models, stores, retrieval, ingestion, derivation, runtime services, and service facades.
- `adapters/claude/` — Claude Code hook and transcript adapter behavior.
- `extensions/` — optional vector, shared-memory, endless-memory, and MCP extension boundaries/services.
- `apps/` — CLI, server/API, dashboard/UI, and packaging-facing application behavior.

Run all tests with:

```bash
npm test -- --run
```

Run one architecture slice with:

```bash
npm test -- --run tests/core
npm test -- --run tests/adapters/claude
npm test -- --run tests/extensions
npm test -- --run tests/apps
```
