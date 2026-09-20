# Authenticated Lesson Host Contract v1

`dist/services/lesson-host-service.js` is the stable CML package entry point
for a trusted host (Desktop or Happy). It is a callable in-process service,
not an HTTP endpoint. CML does not mint identity, accept anonymous REST
requests, or invoke a provider from this contract.

## Construction

```ts
import { openLessonHostService } from 'claude-memory-layer/dist/services/lesson-host-service.js';

const { service, close } = await openLessonHostService({ projectPath, verifyBinding });
```

The factory resolves the canonical host path and runs CML SQLite migration
before returning the service. `projectPath` is host-resolved, never a
renderer/model DTO. `isolatedStorageRoot` is an explicit test-only fixture
option. Hosts must not import `dist/core/*` or open SQLite directly.

`verifyBinding` receives an opaque host credential and returns a verified
binding, or throws. The verified binding supplies `projectHash`, `actorId`,
`userId`, `machineId`, `sessionId`, `generation`, and capabilities. A request
cannot provide or override any of these fields.

```ts
interface VerifiedLessonHostBinding {
  projectHash: string;
  actorId: string;
  userId: string;
  machineId: string;
  sessionId: string;
  generation: number;
  capabilities: readonly ('lesson.read' | 'lesson.review' | 'lesson.manage')[];
}
```

Every request has `{ version: 1, requestId, binding }`; unsupported versions
return `{ outcome: 'unsupported_version' }`. `requestId` is idempotent only
for the operation, verified scope, and canonical request payload that
originally claimed it; a reuse with a different payload is `request_conflict`.

## Model-readable operations

`recall({ version, requestId, binding, turnId, query, limit? })` and
`get({ version, requestId, binding, lessonId })` require `lesson.read`.
They only read the binding project and return bounded lesson refs/bodies.
`recall` produces `selected` trace records; it does **not** claim delivery.

`ackDelivery({ version, requestId, binding, turnId, traceId, lessonIds,
lessonRevisions })`
is host-only (not model-facing), requires `lesson.read`, and the same current
generation/session as selection. It records `delivered` only after the host
says provider input was accepted;
replays return the original typed result. `recordRead` separately records a
lesson body read. Trace records contain ids, scope-safe outcome, and times,
never query or raw lesson/evidence text.

## UI-only mutations

The verified opt-in host review worker uses `enqueueCandidate` and
`markReviewed` with `lesson.review`; these transitions still only create or
review a proposal and never persist a lesson. Authenticated UI actions use
`approveCandidate`, `rejectCandidate`, and `setRecallEnabled` with
`lesson.manage`. There is no `actor`, `approved`, or approval boolean in these
DTOs: the verifier and the appropriate host/UI capability are the sole
authority. `listCandidates`/`listLessons` are paginated at 100 items and
`reviewStatus` is a UI service read. `listTraces` is a `lesson.manage` UI read
with the same pagination; it exposes only id/revision pairs, scope identity,
phase/outcome, and timestamps (never query or body text).
`listLessons` includes `lastSelectedAt`, `lastDeliveredAt`, and `lastReadAt`
from actual host traces; unavailable historical phases remain `null`.

Candidates persist `pending`, `reviewed`, `accepted`, `rejected`, or
`expired`, plus `evidenceKey`, CML-computed SHA-256 `payloadHash`, `revision`,
and evidence refs. Every background candidate payload requires `scope`, one or
more `validation` results, and `reconsiderWhen`; `validVersions` is optional.
These are preserved in the UI snapshot alongside source refs and timestamps.
Snapshots also contain read-only lexical `duplicateLessonIds`; approval never
auto-merges or overwrites those lessons.
`enqueueCandidate` accepts a candidate and optional
`payloadHash`; when present it must equal CML's canonical hash, and all source
event refs must belong to the verified project. It returns
`{ outcome, candidateId, evidenceKey, payloadHash, revision, status }`.
`listCandidates`/`reviewStatus` return the same safe metadata plus candidate
payload; they never return raw source-event bodies.

`appendNormalEndEvidence({ version, requestId, binding, generation, evidenceKey,
sessionId, content, occurredAt? })` is a host-review-worker operation. It
requires `lesson.review`, a binding whose verified normal-end session set
contains the exact current session, and bounded privacy-filtered content. It
uses CML's existing event ingestion path and returns the actual persisted
`eventId`; it does not accept a caller event id, write event SQL directly, or
trust a DTO normal-end flag. `evidenceKey` and request id are idempotent.

The stable service entry exports `LESSON_HOST_CAPABILITIES` with `version: 1`
and `nativeLessonOwnerMarker: true`. Hosts check these exact values on the
installed artifact before choosing host ownership for a provider launch.

When a host owns provider lesson injection it may set the launch-only
environment marker `CLAUDE_MEMORY_LESSON_OWNER=host`. The native Claude
`user-prompt-submit` and `session-start` hooks then skip only their curated lesson lanes; event-memory
retrieval is unchanged. Absent or other values preserve native ownership. The
host must not set this marker unless it actually injects lessons; it is neither
persisted nor a user setting or managed-hook change.

`markReviewed({ candidateId, expectedRevision, payloadHash, generation })`,
`approveCandidate({ candidateId, expectedRevision, payloadHash, generation })`,
and `rejectCandidate({ candidateId, expectedRevision, payloadHash, generation,
reason? })` use exact revision/hash CAS. Background enqueue/review transitions
also require the candidate creation generation; approval deliberately does not:
a reviewed proposal may survive a worker restart or review-setting change. Its
current UI binding generation is nevertheless checked again immediately before
the atomic approval transaction. `setRecallEnabled({
lessonId, expectedRevision, enabled, generation })` is the corresponding UI
revocation mutation. Approval atomically upserts the lesson and marks the
candidate accepted; a stale revision, revoked recall, lost capability, or
generation mismatch writes neither record. A model `no-lesson` reflection is
represented by no enqueue call and therefore creates no candidate.

If approval collides with an existing lesson name, CML returns a merge-required
conflict: it never auto-overwrites a semantically similar lesson. A future
explicit merge requires the target lesson revision and separate UI consent.

## Lifecycle and compatibility

Lesson recall requires both the CML recall flag and the existing registered
asset lifecycle when an asset exists. In legacy mode, the additive CML flag
still excludes disabled lessons from every automatic reader; re-enabling
restores them. Existing explicit `mem-lesson-save` stays compatible and
increments the lesson revision.

The host must cancel/fence work when its grant generation changes. CML checks
the verified binding at each callable entry and again immediately before each
write; approval's candidate/lesson transaction has no async gap between its
final fence and commit. CML never treats model arguments as identity or
approval. Gateway pricing, reservation, usage, and provider execution remain
host responsibilities.

Trace rows retain selected lesson id/revision pairs and timestamps, never raw
query/evidence. Delivery acknowledgement fails when a selected revision has
changed. A host `get` that returns a body records `read`; legacy MCP reads are
outside this host trace contract.

Recall has a CML-internal 900ms read/permission/ranking deadline. It scans in
100-item pages, yields between pages, and retains only page-local candidates
before a final bounded ranking. On deadline it returns `{ outcome: 'timeout',
lessonIds: [], lessons: [] }`, writes no `selected` trace, and injects nothing.
This is a safety budget, not a claim that the current warm lexical benchmark
proves an end-to-end hard latency bound. Any hybrid embedding path must obey
the same deadline before it can be enabled for injection.
