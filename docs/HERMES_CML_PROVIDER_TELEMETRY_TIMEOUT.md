# Hermes CML provider telemetry and timeout path

This note separates the CML repository surface from the Hermes provider-plugin surface for the read-only `claude_memory_layer` memory provider.

## Decision

No CML production code change is required for this slice. The current CML MCP `mem-context-pack` response is already backward compatible for Hermes provider use:

- It accepts optional `compression` plus `maxChars`/`maxTokens` inputs.
- It keeps `Relevant memories: <n>` in the rendered context pack.
- When compression runs and the budget is large enough, it emits aggregate `Compression telemetry` with counts such as `items`, `originalChars`, `compressedChars`, and `savedChars`.
- If an older CML server does not return telemetry, the provider simply omits those optional telemetry fields.

The implementation therefore lives in the default-profile Hermes plugin at `~/.hermes/plugins/claude_memory_layer`, not in CML sync/import code. It remains read-only: `sync_turn()` is a no-op and no Hermes turns are written back to CML.

## Hermes plugin behavior implemented

Changed default-profile plugin files:

- `~/.hermes/plugins/claude_memory_layer/__init__.py`
- `~/.hermes/plugins/claude_memory_layer/README.md`
- `~/.hermes/plugins/claude_memory_layer/plugin.yaml`
- `~/.hermes/plugins/claude_memory_layer/tests/test_provider_timeout_telemetry.py`

Provider behavior:

1. Prefetch calls the configured MCP context-pack tool with existing read-only args plus optional `compression` and `maxChars` budget args.
2. The provider explicitly passes `refreshLatest: false` on every MCP context-pack call so generic continuation prompts cannot trigger CML latest-session import/live ingestion.
3. Calls run in a daemon worker thread and the Hermes turn waits only up to `timeout_ms` (default `2500`).
4. Timeout, tool-unavailable, empty-result, in-flight, and exception cases fail closed by returning empty context or a fresh exact-query cache hit.
5. The cache is exact-query/config scoped and controlled by `cache_ttl_seconds` (default `300`, `0` disables it).
6. Debug telemetry uses safe aggregate fields only: `status`, `duration_ms`, `selected_memory_count`, `context_chars`, `returned_chars`, optional compression counts, and a bounded failure reason code such as `timeout` or exception class name.
7. Telemetry intentionally excludes raw prompt/query text, project paths, raw context, raw tool output, raw exception messages, secrets, and token-looking strings.

## Config additions

```yaml
memory:
  provider: claude_memory_layer
  claude_memory_layer:
    compression: safe
    timeout_ms: 2500
    cache_ttl_seconds: 300
```

Environment overrides:

- `CLAUDE_MEMORY_LAYER_COMPRESSION`
- `CLAUDE_MEMORY_LAYER_TIMEOUT_MS`
- `CLAUDE_MEMORY_LAYER_CACHE_TTL_SECONDS`

Existing config keys remain unchanged: `context_tool`, `project_path`, `top_k`, `recent_limit`, `session_limit`, `max_chars`, and external CML `session_id` filter.

## Validation run

Focused Hermes plugin validation:

```bash
cd ~/.hermes/hermes-agent
python -m pytest -q ~/.hermes/plugins/claude_memory_layer/tests/test_provider_timeout_telemetry.py
python -m compileall -q ~/.hermes/plugins/claude_memory_layer
```

CML repository validation for this task should still include the standard compiled-code checks when run on a worktree containing active CML changes:

```bash
cd "$CML_REPO"
npm test -- --run tests/extensions/mcp-context-tools.test.ts tests/core/context-compressor.test.ts
npm run typecheck
npm run build
```

## Privacy notes

Do not enable live sync in this provider unless a separate task explicitly changes the product decision. If provider debug logs are inspected, verify they contain only aggregate telemetry and safe reason codes, not raw prompts, local paths, CML context text, or exception messages.
