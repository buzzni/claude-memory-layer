# Runtime Embedding Broker Decision

> **Status**: No broker for this change; re-evaluate after representative instrumented samples
> **Date**: 2026-08-12
> **Scope**: MCP and Claude semantic-daemon embedding runtimes

## Context

The runtime-efficiency roadmap permits a shared embedding broker only when post-`2.2.10` evidence demonstrates either:

- sustained duplicate-model RSS of at least 1 GiB, or
- repeated material cold-load latency after idle release,

with enough versioned samples to exclude legacy clients, expected detached daemons, and transient spikes.

A pre-instrumentation point-in-time sample observed 19 attached MCP processes using about 8.7 GiB aggregate RSS, one expected detached semantic daemon using about 1.5 GiB, and one 30 MiB orphan MCP process. The installed/source package version was `2.2.10`, but those process instances could not be attributed to a loaded model, a particular running package version, or sustained duplicate-model residency. Aggregate RSS alone therefore does not satisfy the broker gate.

## Decision

Do not build or install an embedding broker in this work packet.

Keep the existing in-process embedding design and idle release. Add privacy-safe process-local lifecycle telemetry and a read-only aggregate `runtime-status` report so later samples can distinguish:

- current instrumented clients from legacy or uninstrumented clients,
- MCP processes from the intentionally detached semantic daemon,
- loaded, unloaded, and unavailable model state,
- load/release counts and reasons,
- cold and hot semantic retrieval latency,
- attached MCP processes from actual orphan MCP processes.

Model/backend identity is a short one-way digest. Snapshots contain no command line, query, transcript, project path, or credential. The status report emits aggregate groups without PID or PPID. Runtime snapshot persistence can be disabled with `CLAUDE_MEMORY_DISABLE_RUNTIME_TELEMETRY=1`.

## Alternatives considered

### Continue in-process idle release — selected

This preserves compatibility and adds evidence without introducing IPC, another service lifecycle, or a new failure domain. Concurrent first use of one `Embedder` instance is coalesced into one model load.

### Local shared embedding broker — deferred

This remains an option only after the evidence gate. A later design must use local-only transport, one lazy model, bounded requests and timeouts, idle shutdown, client audit where appropriate, provider/in-process fallback, and no canonical-store ownership.

### Provider-only embeddings — not selected as the default

This could reduce local RSS but changes offline behavior, privacy, availability, latency, and cost. It remains a configurable alternative rather than a replacement for the local default.

## Measurement and promotion gate

After a release containing this telemetry is installed, collect representative aggregate samples from real MCP clients and the semantic daemon:

1. capture multiple active and idle windows with `runtime-status --json`,
2. retain only aggregate output,
3. exclude `legacy-or-uninstrumented` groups from the broker calculation,
4. compare loaded versus released RSS and cold versus hot latency,
5. require repeated observations rather than one spike.

If the gate is not met, continue tuning in-process idle release. If it is met, write a separate broker specification and rollback plan before implementation. Production canaries still require explicit user approval.

## Rollback

The telemetry/reporting code does not change retrieval ranking or canonical storage. Roll back by reverting the telemetry instrumentation and command. Operators can stop snapshot writes immediately with `CLAUDE_MEMORY_DISABLE_RUNTIME_TELEMETRY=1`; existing snapshots are ignored unless `runtime-status` reads them and do not own canonical data.
