# Runtime Resource Efficiency Context

> **Status**: Incubating
> **Parent**: [`../spec.md`](../spec.md)

## Problem

Runtime snapshots showed roughly 18-20 MCP processes using about 2 GiB combined, plus a semantic daemon that could use around 700 MiB while active. Version `2.2.10` added shutdown hardening and ten-minute idle resource release, and legacy orphan processes were removed. Current measurements are not sufficient to tell whether remaining memory is active work, model duplication, clients running old versions, or resources that fail to release.

A shared embedding broker would add IPC, lifecycle, failure, and security complexity. It is a possible outcome of measurement, not the assumed architecture.

## Relevant code

- `src/extensions/mcp/idle-resources.ts`
- `src/extensions/mcp/process-lifecycle.ts`
- `src/extensions/mcp/index.ts`
- `src/extensions/vector/embedder.ts`
- semantic daemon/client under `src/adapters/claude/hooks/`
- runtime health and CLI/dashboard aggregate reporting

## Boundaries

- Stats and lexical/fast retrieval should not initialize semantic models.
- Telemetry output is aggregate and must not expose process command secrets or private paths.
- Do not install a background service or broker without explicit approval.
