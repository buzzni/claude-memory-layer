# MU-06: Usefulness Telemetry Calibration

Status: Proposed — audit-based

Priority: P2

Primary surfaces: retrieval traces, helpfulness evaluation, dashboard KPIs

## Problem

The existing helpfulness score combines retrieval score, continued conversation, prompt count, tool success, and content overlap. In the audited projects, average scores cluster near neutral, tool success is effectively 100%, and re-ask rates are high. These signals are not sufficiently discriminative to decide whether a retrieved memory caused a better outcome. Reference delivery and evidence delivery also have different observable outcomes and must not share one interpretation.

## Goals

- Separate delivery, adoption, grounding, navigation, task outcome, and explicit feedback.
- Represent unknown/unmeasured outcomes distinctly from neutral or negative outcomes.
- Calibrate derived usefulness against reviewed fixtures and explicit feedback.
- Preserve privacy and bounded telemetry.

## Non-goals

- Claiming causal impact from correlation alone.
- Storing full assistant responses or raw prompts in aggregate telemetry.
- Replacing retrieval replay metrics with a single helpfulness number.
- Penalizing a reference merely because its text was not copied into an answer.

## Measurement model

The system MUST expose a funnel rather than only a blended score:

```text
eligible candidate
  -> selected
  -> delivered
  -> adopted (evidence) / navigated (reference)
  -> task outcome observed
  -> explicit feedback, when supplied
```

## Requirements

### Typed outcome dimensions

- **UT-001** `selected`, `delivered`, `grounded`, `navigated`, `taskOutcome`, and `feedback` MUST be separate dimensions.
- **UT-002** Every dimension supports `unknown`; unknown MUST not be serialized as zero or neutral.
- **UT-003** Evidence and reference presentations use different adoption signals.
- **UT-004** Core-memory delivery is reported separately from query-triggered retrieval.
- **UT-005** SessionStart traces are excluded from user-query yield unless explicitly requested.

Proposed read model:

```ts
interface MemoryUsefulnessObservationV2 {
  traceId: string;
  eventId: string;
  presentationMode: 'evidence' | 'reference' | 'core' | 'unknown';
  triggerType: 'session_start' | 'user_prompt' | 'explicit_search' | 'context_pack' | 'unknown';
  selected: boolean;
  delivered: boolean | null;
  adoption: 'grounded' | 'navigated' | 'not_observed' | 'unknown';
  contentOverlapScore: number | null;
  taskOutcome: 'success' | 'failure' | 'mixed' | 'unknown';
  reaskOutcome: 'clarification' | 'repeat_failure' | 'topic_continuation' | 'none' | 'unknown';
  explicitFeedback: 'positive' | 'negative' | null;
  confidence: number;
  evaluatedAt: string | null;
  evaluatorVersion: string;
}
```

### Delivery and adoption

- **UT-006** Evidence adoption is evaluated only against the bounded injected content actually shown to the model.
- **UT-007** Evidence grounding reports overlap/evidence matches and a calibrated threshold.
- **UT-008** Reference adoption requires an attributed navigation event; absence remains `not_observed`, not negative.
- **UT-009** Navigation attribution MUST remain session/time bounded.
- **UT-010** Core-memory use cannot be inferred from later lexical overlap alone; it remains delivered/unknown unless stronger evidence exists.

### Tool outcome

- **UT-011** Unparseable tool observations MUST not default to success.
- **UT-012** Tool parsers MUST classify explicit success, explicit failure, and unknown by known adapter schema.
- **UT-013** Task outcome MUST consider only operations after delivery and within the evaluation window.
- **UT-014** A tool success without evidence adoption MUST not be attributed to memory usefulness.

### Re-ask classification

- **UT-015** The existing lexical-overlap flag MUST not be used as a direct penalty.
- **UT-016** Re-asks MUST be classified as clarification, repeated failure, normal continuation, none, or unknown.
- **UT-017** Classification MAY use deterministic features first; an optional evaluator must use privacy-filtered bounded snippets.
- **UT-018** The evaluation window and similarity thresholds are versioned.

### Scores and aggregates

- **UT-019** Raw dimensions are canonical; any blended score is a versioned projection.
- **UT-020** Aggregate output MUST include numerator, denominator, unknown count, and confidence interval or minimum-sample warning.
- **UT-021** A project with fewer than the configured minimum evaluated observations MUST display `insufficient_sample`.
- **UT-022** Explicit feedback MUST be reported separately and MAY calibrate, but not silently overwrite, behavioral observations.
- **UT-023** Old v1 helpfulness remains readable during a dual-read migration window.

Suggested aggregate:

```ts
interface UsefulnessAggregateV2 {
  eligible: number;
  selected: number;
  delivered: number;
  evidenceEvaluated: number;
  evidenceGrounded: number;
  referencesEligible: number;
  referencesNavigated: number;
  taskOutcomesEvaluated: number;
  taskOutcomesSuccessful: number;
  explicitPositive: number;
  explicitNegative: number;
  unknown: number;
  sampleState: 'sufficient' | 'insufficient_sample';
  evaluatorVersion: string;
}
```

### Persistence

- **UT-024** Additive v2 columns or a new normalized observation table MUST retain trace/event linkage and evaluator version.
- **UT-025** Evaluation writes are idempotent by trace, event, observation kind, and evaluator version.
- **UT-026** Re-evaluation creates a new versioned observation or audited replacement; it does not silently mutate historical semantics.
- **UT-027** Persisted evidence snippets remain bounded, privacy-filtered, and optional.

## Calibration dataset

Create reviewed fixtures covering:

- relevant memory visibly reused in an answer;
- selected but irrelevant memory;
- reference opened and used;
- reference not opened;
- successful tool unrelated to delivered memory;
- explicit tool failure;
- unparseable/unknown tool result;
- user clarification;
- repeated failure/re-ask;
- normal same-topic continuation;
- session ending immediately after delivery;
- no assistant response after delivery.

Fixtures MUST contain synthetic or anonymized text and explicit expected dimensions.

## Dashboard/API behavior

- Show selection yield, grounding, reference navigation, task outcome, and explicit feedback as separate cards.
- Show denominators and unknown counts.
- Do not render unknown as `0%`.
- Label evaluator version and time window.
- Preserve progressive evidence drill-down only where the caller already has project access.

## Test specification

Required cases:

- unparseable tool output becomes unknown;
- explicit tool success/failure parse correctly;
- tool success without adoption is not memory success;
- evidence overlap uses injected snapshot, not full stored event;
- reference open attribution is positive; unopened is neutral/not observed;
- clarification and repeated failure are distinct;
- unknown outcomes excluded from measured denominators;
- small samples return insufficient state;
- v1 rows remain readable;
- v2 re-evaluation is idempotent/versioned;
- privacy filter bounds snippets and removes secrets/paths;
- dashboard displays `n/a` for unmeasured metrics.

Primary files:

- `src/core/sqlite-event-store.ts`
- `src/core/retrieval-telemetry.ts`
- `src/core/engine/retrieval-analytics-service.ts`
- `src/apps/server/api/stats.ts`
- `src/apps/dashboard/assets/js/usefulness.js`
- `tests/core/retrieval-telemetry.test.ts`
- `tests/core/usefulness-history.test.ts`
- `tests/apps/dashboard-usefulness-stats.test.ts`

## Migration

1. Introduce evaluator version `v2` and additive storage.
2. Dual-write v1 and v2 for one release where safe.
3. Compute dashboard v2 aggregates while retaining a v1 compatibility endpoint/field.
4. Compare distributions against fixtures and sampled reviewed traces.
5. Switch default dashboard labels to v2.
6. Stop new v1 evaluation writes only after compatibility consumers are identified.

Historical v1 rows are not automatically reinterpreted as v2. Optional backfill requires the necessary bounded evidence; otherwise the v2 value remains unknown.

## Observability

- evaluator run/failure counts by version;
- unknown rate by dimension;
- adoption and task-outcome denominators;
- distribution drift against the prior release;
- explicit feedback counts.

Project paths, queries, responses, and evidence text are excluded from machine-wide aggregates.

## Rollback

- Dashboard can switch back to v1 reads.
- V2 tables/columns are additive and can remain dormant.
- Do not delete v2 observations on rollback; preserve evaluator provenance.

## Acceptance criteria

- Positive, neutral/not-observed, negative, and unknown fixtures are separable.
- Tool success no longer defaults to 100% because unknown parses are counted correctly.
- Re-ask classification no longer treats ordinary continuation as failure.
- Every rate exposes its denominator and unknown count.
- Dashboard and API never display unknown as a measured zero.
- No new telemetry leaks raw private content or unbounded identifiers.
