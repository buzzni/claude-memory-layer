# Runtime Resource Efficiency Specification

> **Status**: Incubating

## Requirements

### RRE-001 — Model lifecycle telemetry

Expose process-local model/backend loaded state, load count/duration, release count/time/reason, last relevant activity, and cold/hot retrieval latency. Backend identity may be opaque.

### RRE-002 — Resource observation

Provide supported-platform aggregate process count/RSS and model-state reporting with version/client grouping sufficient to exclude legacy clients. Unsupported metrics degrade explicitly rather than fabricating zero.

### RRE-003 — Fast path

Stats, status, lexical retrieval, and other non-semantic paths must not load the embedding model. Idle release must be observable and covered by deterministic lifecycle tests.

### RRE-004 — Broker decision gate

Create a broker ADR/spec only if representative post-`2.2.10` evidence shows sustained duplicate-model RSS of at least 1 GiB or repeated material model-load latency after idle release, with enough samples to exclude legacy clients and transient spikes.

### RRE-005 — Broker constraints if approved

Any later broker uses local-only transport, one lazy model instance, idle shutdown, bounded requests/timeouts, client audit where appropriate, in-process/provider fallback, and no canonical-store ownership. Target at least 50% embedding-related aggregate RSS reduction without quality regression.

## Acceptance

- Load/release and cold/hot events are observable without raw/private data.
- Tests prove fast paths avoid model initialization.
- Field sample distinguishes current and legacy clients.
- An ADR records broker, in-process idle release, and provider alternatives.
- If the gate is not met, a documented no-broker decision completes this feature.

## Non-goals

- building a broker before the gate,
- centralizing canonical storage,
- adding network-accessible embedding service,
- treating RSS alone as proof of a leak.
