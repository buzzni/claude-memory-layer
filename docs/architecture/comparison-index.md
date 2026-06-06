# Memory Architecture Comparison Index

This index gathers the comparison/architecture notes used to guide the claude-memory-layer refactor and retrieval UX work.

## Documents
- [Memory Forget](../../.claude-plugin/commands/memory-forget.md)
- [Memory History](../../.claude-plugin/commands/memory-history.md)
- [Memory Import](../../.claude-plugin/commands/memory-import.md)
- [Memory List](../../.claude-plugin/commands/memory-list.md)
- [Memory Search](../../.claude-plugin/commands/memory-search.md)
- [Memory Stats](../../.claude-plugin/commands/memory-stats.md)
- [Readme](../../README.md)
- [Context](../../context.md)
- [Memory Forget](../../dist/.claude-plugin/commands/memory-forget.md)
- [Memory History](../../dist/.claude-plugin/commands/memory-history.md)
- [Memory Import](../../dist/.claude-plugin/commands/memory-import.md)
- [Memory List](../../dist/.claude-plugin/commands/memory-list.md)
- [Memory Search](../../dist/.claude-plugin/commands/memory-search.md)
- [Memory Stats](../../dist/.claude-plugin/commands/memory-stats.md)
- [Architecture Comparison And Recommendations](../../docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md)
- [Mcp Memory Service Comparative Review](../../docs/MCP_MEMORY_SERVICE_COMPARATIVE_REVIEW.md)
- [MemPalace Targeted Improvement Plan](mempalace-targeted-improvement-plan.md)
- [Memsearch Project Structure Analysis](../../docs/MEMSEARCH_PROJECT_STRUCTURE_ANALYSIS.md)
- [Memu Adoption](../../docs/MEMU_ADOPTION.md)
- [Project Structure Analysis](../../docs/PROJECT_STRUCTURE_ANALYSIS.md)
- [Reference Project Analyses](../../docs/REFERENCE_PROJECT_ANALYSES.md)
- [Superlocalmemory Project Structure Analysis](../../docs/SUPERLOCALMEMORY_PROJECT_STRUCTURE_ANALYSIS.md)
- [Target Architecture And Folder Structure](../../docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md)
- [Context](../../specs/endless-mode/context.md)
- [Spec](../../specs/endless-mode/spec.md)
- [Context](../../specs/evidence-aligner-v2/context.md)
- [Context](../../specs/memory-utilization-improvements/context.md)
- [Plan](../../specs/memory-utilization-improvements/plan.md)
- [Spec](../../specs/memory-utilization-improvements/spec.md)
- [Spec](../../specs/thin-core-refactor/spec.md)
- [Plan](../../specs/web-viewer-ui/plan.md)

## Current implementation links

- `src/core/engine/retrieval-orchestrator.ts` — extracted retrieval coordination facade for `MemoryService`.
- `src/core/engine/retrieval-disclosure-service.ts` — product-facing progressive disclosure search → expand → source API.
- `src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css` — dashboard inspection UX for retrieval disclosure.

## Refactor direction

1. Keep `MemoryService` focused on lifecycle/storage/use-case composition.
2. Route query-time behavior through `RetrievalOrchestrator` so scope, rerank policy, intent rewrite, shared retrieval, and trace telemetry are testable in isolation.
3. Expose compact retrieval envelopes first, then progressively expand to surrounding context and raw sources when the operator needs evidence.
