# Spec: Honcho-inspired Peer Context Memory

> **Status**: Implemented P0/P1 manual perspective-memory slice; validated 2026-05-23 (lint unavailable: eslint binary missing)
> **Created**: 2026-05-23
> **Reference OSS**: `honcho`
> **Target repo**: `claude-memory-layer`

## 1. Goal

Honcho의 `Peer`, `Session`, `Representation`, `Peer Card`, `Dialectic`, `Dreamer` 구조를 참고해 Claude Memory Layer(CML)에 **관점(perspective) 기반 actor memory**를 추가한다.

현재 CML은 project/session/event 중심으로 기억을 저장하고 검색한다. 이는 단일 사용자/단일 에이전트 작업에는 충분하지만, 다음 상황에서는 정보 구조가 약하다.

- Discord/Telegram/group chat처럼 여러 사용자가 같은 session에 참여하는 경우
- Hermes/Codex/Claude/subagent/tool 등 여러 agent actor가 같은 프로젝트 기억을 만들고 소비하는 경우
- “A가 B에 대해 알고 있는 것”, “이 session 안에서 manager가 coder에게 남긴 맥락”, “사용자 전하에 대한 durable identity/instruction”처럼 **관점과 대상**이 중요한 경우
- 프로젝트 맥락과 개인/조직/에이전트 맥락이 섞이면서 retrieval contamination이나 privacy leak 위험이 커지는 경우

이 spec의 목표는 CML의 기존 EventStore/Vector/Retriever/Operations layer 위에, Honcho식 **observer → observed 관점 메모리**를 얇고 안전하게 얹는 것이다.

## 2. Why a new spec?

기존 specs 중 관련 요소는 있지만, Honcho의 핵심 기능을 하나로 담는 기능 spec은 없다.

- `entity-edge-model`: 관계 그래프의 기반은 맞지만 task/entity relation 중심이며 actor perspective, peer card, 관점별 representation을 다루지 않는다.
- `agentmemory-inspired-memory-operations`: facet/action/retention/lesson 운영 primitives는 관련 있지만, multi-peer theory-of-mind memory 모델은 없다.
- `memory-utilization-improvements`: retrieval trace/quality 개선은 관련 있지만, actor/observer/observed 스키마는 없다.

따라서 `specs/honcho-inspired-peer-context-memory/`를 신규 생성하고, 기존 specs와의 연결점을 명시한다.

## 3. Core Concepts

| Honcho concept | CML equivalent/proposal | Purpose |
| --- | --- | --- |
| Workspace | `projectHash` / global memory store | isolation boundary |
| Peer | `MemoryActor` | user, assistant, subagent, tool, integration identity |
| Session | existing `Session` + `SessionActor` membership | conversation/task boundary |
| Message | existing `MemoryEvent` | immutable source evidence |
| Collection `(observer, observed)` | `PerspectiveCollection` | a named memory space for one actor's view of another |
| Document/Conclusion | `PerspectiveObservation` | explicit/deductive/inductive/contradiction claim with source evidence |
| Representation | curated observation bundle | context assembled for target actor from observer perspective |
| Peer Card | `ActorCard` | compact durable identity/instruction markers |
| Deriver | `PerspectiveDeriver` | background extraction from events into observations |
| Dialectic | `PerspectiveQueryAgent` | tool-using, query-driven contextual reasoning |
| Dreamer | `PerspectiveConsolidator` | offline high-level deductions/inductions/contradictions |

## 4. Functional Requirements

### FR-1. Actor registry

CML MUST introduce a privacy-safe actor identity model.

A `MemoryActor` represents a human, assistant, subagent, tool, system, or external integration source.

Required fields:

- `actorId`: stable id, deterministic where possible
- `projectHash`: optional; absent means global actor
- `kind`: `user | assistant | subagent | tool | system | integration | unknown`
- `displayName`: redacted/safe display name
- `source`: e.g. `hermes`, `claude`, `codex`, `mcp`, `discord`, `telegram`, `tool`
- `metadataJson`: optional, privacy-filtered
- `createdAt`, `updatedAt`

Actor projection SHOULD derive from existing metadata where available:

- event metadata `source`, `role`, `toolName`, `model`, `user_id`, platform hints
- session/import source metadata
- explicit CLI/MCP arguments for manual actor tagging

### FR-2. Session actor membership and observation policy

CML MUST track actor participation per session.

`SessionActor` fields:

- `projectHash`
- `sessionId`
- `actorId`
- `roleInSession`: `speaker | assistant | observer | tool | system | unknown`
- `observeSelf`: default `true` for user/assistant actors
- `observeOthers`: default `false` unless explicitly configured
- `joinedAt`, `leftAt`

Observation policy MUST be configurable and capped to avoid combinatorial explosion.

Initial defaults:

- Direct local sessions: self-observation only (`observer = observed = actorId`)
- Group/platform sessions: observe self; observe others only when configured
- Tools: stored as evidence but not observed as durable people unless explicitly opted in
- Max observers per session: default 5

### FR-3. Perspective observations

CML MUST support observations scoped by `(projectHash, observerActorId, observedActorId)` with optional `sessionId`.

Observation levels:

- `explicit`: directly grounded fact from event(s)
- `deductive`: logically derived conclusion from one or more observations
- `inductive`: pattern/generalization from multiple observations
- `contradiction`: conflicting claims requiring user/agent attention

Required fields:

- `observationId`
- `projectHash`
- `observerActorId`
- `observedActorId`
- `sessionId?`
- `level`
- `content`
- `confidence` (`0..1`)
- `sourceEventIds[]` and/or `sourceObservationIds[]`
- `createdBy`: `rule | llm | manual | import`
- `createdAt`, `updatedAt`, `deletedAt?`

Every non-manual observation MUST retain source evidence pointers. Raw source content MUST NOT be duplicated into observation metadata beyond privacy-filtered snippets.

### FR-4. Actor cards

CML MUST support compact actor cards similar to Honcho peer cards.

Actor card entries are durable, low-token identity or instruction markers about an observed actor from an observer perspective.

Allowed entry prefixes:

- `IDENTITY:` durable identity marker
- `ATTRIBUTE:` stable preference/trait/capability
- `RELATIONSHIP:` durable relation to another actor/project/org
- `INSTRUCTION:` durable instruction preference

Constraints:

- max entries per card: 40
- max chars per entry: 200
- each entry should have `sourceEventIds` or explicit manual actor
- no secrets/tokens/credentials
- privacy filter applied before persistence and before output

### FR-5. Context pack integration

`mem-context-pack` MUST be extendable with perspective options:

- `observerActorId?`
- `targetActorId?`
- `includeActorCard?: boolean`
- `includePerspectiveObservations?: boolean`
- `limitToSession?: boolean`
- `reasoningLevel?: minimal | low | medium | high`

When these options are present, the context pack SHOULD include:

1. project/session timeline as today
2. compact actor card for `(observer, target)`
3. relevant observations split by level
4. source references using privacy-safe citations
5. selected debug trace explaining why observations were included

The context pack MUST degrade gracefully when no actor/perspective data exists.

### FR-6. Retrieval separation to prevent dilution

CML SHOULD keep these retrieval lanes separate before merging:

- raw event retrieval
- session summary retrieval
- actor card retrieval
- explicit perspective observations
- higher-level perspective observations (`deductive`, `inductive`, `contradiction`)

This mirrors Honcho's separate explicit-vs-derived prefetch and reduces a common failure mode where high-level summaries crowd out direct evidence, or noisy raw events crowd out durable conclusions.

### FR-7. MCP/CLI surface

Initial MCP tools SHOULD be read-heavy and privacy-safe:

- `mem-actor-list`
- `mem-actor-card-get`
- `mem-perspective-query`
- `mem-perspective-context`

Mutating tools SHOULD require explicit actor/audit fields:

- `mem-actor-card-upsert`
- `mem-perspective-observation-create`
- `mem-perspective-observation-delete`

All mutating tools MUST write governance audit records and require `projectPath` for project-scoped stores.

### FR-8. Background derivation pipeline

CML SHOULD add a bounded derivation pipeline that converts selected events into perspective observations.

Requirements:

- no long-lived DB transaction during LLM calls
- idempotent queue/outbox semantics
- fail-closed on privacy filter or missing source evidence
- source event caps per batch
- token/cost budget per project
- feature flag disabled by default until validated

### FR-9. Dialectic / query-time reasoning

CML MAY add a tool-using `PerspectiveQueryAgent` for questions that require multi-step evidence gathering.

It should:

- prefetch relevant observations first
- expose only minimal tools at low reasoning levels
- cap tool iterations
- cite source references through `mem-source-ref`
- never persist new observations unless explicitly in write mode

### FR-10. Dreamer / consolidation

CML MAY add periodic consolidation specialists after P0/P1:

- deduction specialist: creates logical implications and updates actor cards
- induction specialist: finds repeated patterns
- contradiction specialist: flags conflicts

Specialists MUST be self-limiting and opt-in per project.

### FR-11. Privacy and scoping

The feature MUST preserve CML's existing privacy posture.

- project-scoped stores remain isolated by `projectHash`
- global actor entries must not leak project-specific facts
- actor cards cannot store secrets, tokens, private DB paths, or raw transcripts
- all MCP outputs use the existing privacy filter and source-ref redaction model
- group-chat actor identities are display-safe by default

### FR-12. Observability and evaluation

CML MUST record enough telemetry to answer:

- how many actor cards/observations were created
- which source events support them
- which retrieval lane selected them
- whether they improved context-pack usefulness
- how many were rejected by validation/privacy filters

Scenario tests should cover multi-actor sessions, observe policies, actor card caps, perspective retrieval, and privacy filtering.

## 5. Non-goals

- Do not clone Honcho's FastAPI/Postgres service architecture into CML.
- Do not require a remote server for core local memory behavior.
- Do not persist raw group-chat/user profile data without privacy filtering.
- Do not make every event produce every `(observer, observed)` pair by default.
- Do not replace existing `entity-edge-model`; use it as the graph substrate when available.

## 6. Acceptance Criteria

### P0 acceptance

- Actor projection works for imported/stored events without changing existing event APIs.
- New additive tables/repositories initialize without breaking existing stores.
- Actor card validation rejects invalid prefixes, overlong entries, and suspected secrets.
- `mem-context-pack` output is unchanged when perspective options are omitted.
- Perspective context output includes privacy-safe source references, not raw private metadata.

### P1 acceptance

- Direct/session-scoped perspective observations can be created, queried, and cited.
- Retrieval separates explicit and higher-level observations before final merge.
- Scenario tests demonstrate a multi-actor session where observer A gets a different representation of target B than observer C.
- Project-scope contamination tests pass.

### P2 acceptance

- Background deriver can create explicit observations from selected events with evidence IDs.
- Optional dialectic query agent answers perspective questions with citations.
- Optional consolidator creates deductive/inductive/contradiction observations with source chains.
