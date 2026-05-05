# Hermes Agent memory/session 구조 분석 및 claude-memory-layer 연동 제안

작성 시각: 2026-05-05 23:05 KST
대상 저장소: `/Users/namsangboy/workspace/claude-memory-layer`
참조 Hermes Agent checkout: `/Users/namsangboy/.hermes/hermes-agent` (`7530ce04e`, upstream HEAD와 동일)

## 결론 요약

**Hermes용 ingestion은 만들 가치가 있지만, 지금 바로 `live ingestion`부터 넣는 것은 비추천이다.**

권장 순서는 다음과 같다.

1. **Hermes SessionDB explicit import/validate adapter**를 먼저 만든다. *(1차 구현 완료: `claude-memory-layer hermes validate|replay|import`)*
   - Hermes의 원본 transcript source-of-truth는 `~/.hermes/state.db`로 둔다.
   - claude-memory-layer는 선택된 Hermes 세션을 project-scoped memory store로 복제/파생한다.
   - 현재 CLI는 `--project`, `--session`, `--all`, `--state-db`, `--limit`, `--force`를 제공한다.
2. 그 다음 **“최근 맥락/주제 지도 + wiki-link식 상세 ref 읽기” MCP read-only tool**을 만든다. *(2차 구현 완료: `mem-context-pack`, `mem-project-timeline`, `mem-source-ref`)*
   - 이 기능은 Hermes의 `session_search`와 겹치지만 완전 중복은 아니다.
   - 특히 Claude Code/Codex/Hermes가 같은 프로젝트 memory backend를 공유하려면 의미가 있다.
3. 마지막으로 필요성이 검증되면 **Hermes external memory provider plugin 방식의 opt-in live sync**를 추가한다.
   - 기본은 user/assistant turn만 저장한다.
   - tool output/file content/Bash output 저장은 privacy filter 통과 + explicit opt-in일 때만 허용한다.

즉, **“import + context tool 먼저, live ingestion은 나중”**이 가장 안전하고 실익이 크다.

---

## 1. Hermes Agent에 이미 있는 기능

### 1.1 Built-in curated memory

Hermes 문서와 코드 기준으로, 기본 persistent memory는 두 파일 중심이다.

- `MEMORY.md`: agent personal notes, 환경/프로젝트/교훈 등
- `USER.md`: 사용자 프로필/선호

특징:

- `~/.hermes/memories/` 아래 저장
- 세션 시작 시 system prompt에 frozen snapshot으로 주입
- char limit이 작다: memory 약 2,200 chars, user 약 1,375 chars
- 세션 중 `memory` tool로 add/replace/remove 가능하지만, system prompt 반영은 다음 세션부터

따라서 이 레이어는 “항상 기억해야 하는 소수의 durable fact” 용도이지, 긴 대화/프로젝트별 세부 맥락 저장소가 아니다.

### 1.2 SessionDB + session_search

Hermes는 모든 CLI/gateway 대화를 SQLite에 저장한다.

확인한 local DB:

```text
~/.hermes/state.db
sessions: 656
messages: 14108
source counts:
  discord: 653
  cli: 3
```

스키마 핵심:

- `sessions`: `id`, `source`, `user_id`, `model`, `system_prompt`, `parent_session_id`, `started_at`, `ended_at`, `message_count`, `title` 등
- `messages`: `id`, `session_id`, `role`, `content`, `tool_calls`, `tool_name`, `timestamp`, reasoning/codex fields 등
- `messages_fts`, `messages_fts_trigram`: FTS5 검색용

관련 코드:

- `hermes_state.py`
  - `append_message()`로 메시지 저장
  - `search_messages()`로 FTS5/trigram 검색
  - `list_sessions_rich()`로 recent sessions/preview/last_active 제공
  - `get_messages_as_conversation()`으로 세션 복원
- `tools/session_search_tool.py`
  - query 없으면 최근 세션 metadata 반환
  - query 있으면 FTS5 검색 → 세션별 transcript 로드 → auxiliary LLM으로 요약
  - 현재 세션 lineage는 제외
- `website/docs/developer-guide/session-storage.md`
  - Hermes session store 구조 문서

즉, 사용자가 말한 “특정 대화 세션에서 어떤 주제에 대해 말했는지, 최근 맥락 중심으로 알려주기”의 일부는 이미 Hermes의 `session_search`에 있다.

다만 Hermes 기본 `session_search`는 다음 한계가 있다.

- Hermes 내부 transcript만 대상으로 한다.
- Claude Code/Codex transcript와 같은 project memory backend로 합쳐지지 않는다.
- 반환값은 검색 결과 세션 요약 중심이며, 안정적인 `memory://...` ref를 따라 더 깊게 탐색하는 wiki-link UX는 없다.
- project path scope가 Hermes SessionDB schema에 명시적으로 없다. 현재 `sessions` 테이블에 cwd/project_path 컬럼이 없다.
- derived topic map/decision/task/code-context layer는 없다. FTS match + LLM summary에 가깝다.

### 1.3 External memory provider plugin 구조

Hermes는 built-in memory 외에 외부 memory provider를 하나 활성화할 수 있다.

`hermes memory status` 결과:

```text
Built-in: always active
Provider: (none — built-in only)
Installed plugins: byterover, hindsight, holographic, honcho, mem0, openviking, retaindb, supermemory
```

관련 구조:

- `agent/memory_provider.py`: provider interface
- `agent/memory_manager.py`: provider lifecycle/orchestration
- `plugins/memory/*`: Honcho, Hindsight, OpenViking 등 provider 구현
- `run_agent.py`
  - turn 시작: `memory_manager.on_turn_start()`
  - LLM 호출 전: `memory_manager.prefetch_all(query)` 결과를 current user message에 ephemeral context로 주입
  - turn 종료: `memory_manager.sync_all(original_user_message, final_response, session_id=...)`
  - session 종료: `memory_manager.on_session_end(messages)`

중요한 점:

- Hermes는 이미 “외부 memory backend로 매 턴 sync/prefetch”할 수 있는 확장 포인트를 제공한다.
- 그러므로 live ingestion을 하려면 Hermes core hook을 새로 뚫기보다 **memory provider plugin**으로 붙이는 것이 맞다.
- 하지만 현재 사용자 환경은 external provider가 꺼져 있고 built-in only다.

---

## 2. claude-memory-layer 현재 구조와 source-of-truth

현재 claude-memory-layer는 다음 구조다.

### 2.1 Source-of-truth

`src/core/event-store.ts` 기준:

- L0 `events` table이 append-only source-of-truth
- 주요 event type:
  - `user_prompt`
  - `agent_response`
  - `session_summary`
  - `tool_observation`
- `sessions` table은 session metadata
- `event_dedup`은 idempotency
- `embedding_outbox`, `vector_outbox`, `memory_levels`, `entries/entities/edges` 등은 derived/projection layer

즉 CML의 원본은 “project-scoped memory events”이고, vector/summary/fact/entity/edge는 재생성 가능한 파생물이다.

### 2.2 Project scoping

`src/services/memory-service-registry.ts` 기준:

- default store: `~/.claude-code/memory`
- project store: `getProjectStoragePath(projectPath)`
- `getMemoryServiceForProject(projectPath)`는 project hash별 service를 cache한다.
- 최근 커밋에서 MCP tools가 `projectPath`를 받아 project-specific service를 resolve하도록 변경됐다.

현재 등록된 MCP tools:

- `mem-search`
- `mem-timeline`
- `mem-details`
- `mem-stats`
- `mem-context-pack`
- `mem-project-timeline`
- `mem-source-ref`

`projectPath`가 있으면 project store를 조회하고, 없으면 default store를 조회한다. 특히 context navigator 계열(`mem-context-pack`, `mem-project-timeline`, `mem-source-ref`)은 Hermes/Codex가 작업 시작 전에 project-scoped memory를 빠르게 회수하고, 필요한 근거만 citation/ref로 따라가도록 설계됐다.

### 2.3 Claude/Codex ingestion

현재 상태:

- Claude Code는 `.claude-plugin/hooks.json` 기반 hook ingestion을 유지한다.
- Codex는 explicit CLI import가 추가됐다.
- Codex/Hermes는 CML MCP server를 read-only query tool로 사용할 수 있다.

검증된 커밋:

```text
4bf0915fb1aa09e60bcca482b5ae7650b10ea1eb feat: add project-aware MCP and Codex import CLI
```

검증 결과:

```text
npm run typecheck: passed
npm run build: passed
npm test -- --run: 56 files, 229 tests passed
hermes mcp test claude-memory-layer: connected, tools discovered 4
```

현재 generated local store:

```text
/Users/namsangboy/workspace/claude-memory-layer/memory/  # untracked
```

---

## 3. Hermes built-in 기능과 CML 추가 기능의 gap

| 요구/기능 | Hermes built-in | CML 현재 | CML에 추가할 가치 |
|---|---:|---:|---:|
| 모든 Hermes 대화 원본 저장 | 있음: `~/.hermes/state.db` | 없음 | 낮음. 원본은 Hermes DB가 이미 담당 |
| 최근 세션 목록/preview | 있음: `session_search()` query 없음 | 부분적 | 낮음~중간 |
| 키워드로 과거 Hermes 대화 검색 | 있음: FTS5 + 요약 | MCP `mem-search`, 단 Hermes ingest 필요 | 중간 |
| Claude/Codex/Hermes 공통 project memory | 없음 | 있음: projectPath 기반 | 높음 |
| project-specific long-term context | Hermes schema에 project_path 없음 | 있음 | 높음 |
| 세션별 topic map/최근 맥락 | 일부: search summary | 아직 약함 | 높음 |
| wiki-link식 상세 ref follow-up | 없음 | `mem-details`, `mem-timeline` 기반으로 확장 가능 | 높음 |
| 자동 turn prefetch/context injection | external provider로 가능 | Hermes MCP 수동 호출만 가능 | 중간~높음, opt-in |
| live turn sync | external provider로 가능 | Hermes adapter 없음 | 중간. 하지만 privacy risk 큼 |

핵심은 이렇다.

- **Hermes-only memory**라면 이미 built-in `session_search`와 external providers가 꽤 강하다.
- **Claude Code/Codex/Hermes를 같은 프로젝트 기억층으로 묶는 것**은 Hermes built-in만으로는 해결되지 않는다.
- 따라서 CML이 집중해야 할 차별점은 “Hermes transcript 원본 저장”이 아니라 **cross-agent project memory + topic/ref navigation**이다.

---

## 4. Live ingestion을 바로 만들 때의 리스크

### 4.1 중복 source-of-truth

Hermes는 이미 `~/.hermes/state.db`에 raw transcript를 저장한다.
CML live ingestion이 매 turn 같은 내용을 저장하면:

- Hermes DB와 CML DB가 둘 다 원본처럼 보인다.
- 실패/중단/수정/압축 세션에서 불일치가 생긴다.
- 재import/replay/dedupe 기준이 복잡해진다.

권장 원칙:

- Hermes raw transcript source-of-truth = `~/.hermes/state.db`
- CML source-of-truth = project-scoped derived memory events
- Hermes → CML은 explicit import 또는 opt-in mirror로 취급

### 4.2 Privacy

Hermes 세션에는 tool output, file content, command output, reasoning/codex fields, platform context가 포함될 수 있다.
CML의 기존 privacy 설정은 `password`, `secret`, `api_key`, `token`, `bearer` 등의 exclude pattern이 있지만, live ingestion에는 부족할 수 있다.

특히 위험한 항목:

- Bash/terminal output
- file read/search 결과
- config/log 파일 내용
- OAuth/API token이 포함된 stdout/stderr
- Discord/Telegram group context
- reasoning/codex internal fields

따라서 live ingestion은 다음이 선행되어야 한다.

- credential/secret redaction 강화
- tool output allowlist/denylist
- max chars/lines 제한
- platform/source filter
- group chat privacy policy
- import dry-run report

### 4.3 Project scoping 문제

Hermes `sessions` schema에는 project path/cwd 컬럼이 없다.
따라서 “이 Hermes 세션이 어떤 프로젝트에 속하는가”를 자동 판별하기 어렵다.

가능한 해법:

1. import 시 사용자가 `--project /path --session-id <id>`로 명시한다.
2. Hermes session title/thread/source message에 포함된 경로를 heuristic으로 추출한다.
3. Hermes upstream에 session metadata로 `workdir/project_path` 저장을 제안한다.
4. CML Hermes provider에서 turn sync 시 현재 `workdir`를 metadata로 넘긴다.

현 단계에서는 1번이 가장 안전하다.

---

## 5. 권장 구현 로드맵

### Phase 1 — Hermes explicit import/validate adapter

목표: live ingestion 없이 안전하게 Hermes 과거 세션을 CML project memory로 가져오기.

신규 CLI:

```bash
claude-memory-layer hermes validate --project /path/to/project --format markdown
claude-memory-layer hermes import --project /path/to/project --session <hermes-session-id> --no-process-embeddings
claude-memory-layer hermes import --all --verbose
```

현재 1차 구현 범위:

- read-only validation/replay report (`validate`, `replay`)
- explicit mutation path (`import`)
- project/current-cwd scoped import by default
- `--all` without `--project` only when intentionally using global memory
- user/assistant turns only; tool/system messages skipped
- built-in sensitive pattern redaction before memory storage

추후 확장 후보: `--source`, `--since`, stronger project metadata matching.

구현 포인트:

- source: `~/.hermes/state.db` 직접 read-only open 또는 `hermes sessions export` JSONL 사용
- dedupe key: `hermes:<session_id>:<message_id>:<role>`
- event mapping:
  - user → `user_prompt`
  - assistant → `agent_response`
  - tool → `tool_observation` only if allowlisted/redacted
  - session end or compression summary → `session_summary` if available/derived
- metadata:
  - `sourceAgent: 'hermes'`
  - `hermes.sessionId`
  - `hermes.messageId`
  - `hermes.source` (`cli`, `discord`, etc.)
  - `scope.project.path/hash`
- default: tool output off or aggressively truncated
- `--dry-run` report 필수

TDD:

- fixture SQLite DB 생성
- project-scoped import 검증
- duplicate import idempotency 검증
- privacy redaction 검증
- source/project/session filters 검증

### Phase 2 — context pack + project timeline + source-ref MCP tools

목표: CML이 “검색 결과 목록”에서 “현재 작업 맥락을 이어주는 context navigator”로 발전.

2차 구현 범위:

1. `mem-context-pack`
   - input: `projectPath`, `query?`, `sessionId?`, `topK?`, `recentLimit?`, `sessionLimit?`
   - output:
     - query 관련 memory citations
     - 최근 project timeline/session summary
     - follow-up `mem-source-ref` lookup hints

2. `mem-project-timeline`
   - input: `projectPath`, `limit?`, `sessionLimit?`
   - output:
     - session별 window, source agent/import source, event counts
     - privacy-filtered last preview

3. `mem-source-ref`
   - input: `ids`, `projectPath?`, `maxContentChars?`, `lookupLimit?`
   - 지원 ID 형식: full event ID, `event:<id>`, `mem:<citation>`, bare citation, `[mem:<citation>]`
   - output:
     - source ref, session/type/timestamp
     - allowlisted metadata only
     - redacted preview only

예상 UX:

```text
최근 claude-memory-layer 맥락:
1. Codex/Hermes MCP 등록과 projectPath 지원을 구현/검증했다.
   refs: mem:abc123
2. Hermes explicit import/validate/replay CLI를 TDD로 추가했다.
   refs: mem:def456
3. 남은 이슈: eslint missing, privacy hardening, optional live provider.
   refs: mem:789abc

더 자세히 필요하면 mem-source-ref로 ref를 열어라.
```

이 기능은 Hermes `session_search`와 다르다.

- Hermes `session_search`: Hermes transcript 대상, query-driven summary
- CML context-pack: project memory 전체 대상, Claude/Codex/Hermes 통합, topic/ref 기반 drill-down

### Phase 3 — optional Hermes memory provider plugin

목표: Hermes에서 CML context를 자동 prefetch/inject하고, 완료 turn을 CML에 opt-in sync.

권장 형태:

- Hermes external memory provider plugin: `plugins/memory/claude_memory_layer`
- 설정:

```yaml
memory:
  provider: claude_memory_layer
  claude_memory_layer:
    mode: tools-only | context | hybrid
    writeFrequency: session | turn | off
    projectStrategy: explicit | cwd | global
    toolOutput: off | allowlist | redacted
```

Provider responsibilities:

- `prefetch(query)`: CML `mem-context-pack` 호출 후 current user message에 ephemeral context 주입
- `sync_turn(user, assistant, session_id)`: user/assistant만 기본 저장
- `on_session_end(messages)`: session summary/derived topic update
- provider-specific tools: `cml_search`, `cml_context`, `cml_read_ref`, `cml_import_session`

주의:

- 이 provider를 켜면 Hermes가 자동으로 CML을 호출하므로, MCP tool 수동 호출과 중복 context가 생길 수 있다.
- 따라서 기본값은 `tools-only` 또는 `writeFrequency: off`로 시작하는 것이 안전하다.

---

## 6. 최종 권장안

### 지금 만들 것

1. **Hermes explicit importer/validator**
   - live가 아닌 batch/dry-run 기반
   - Hermes DB를 raw source-of-truth로 존중
   - project/session/source filter 명시

2. **CML context navigator MCP tools**
   - `mem-context-pack`
   - `mem-project-timeline`
   - `mem-source-ref`

이 두 가지는 사용자가 말한 “최근 맥락 중심 context + wiki link처럼 더 깊은 memory file/detail 읽기” 니즈에 직접 대응한다. Phase 2 도구는 raw transcript dumping 대신 citation/ref 기반 follow-up과 redacted preview를 기본으로 한다.

### 지금 만들지 말 것

- Hermes raw transcript를 매 turn 무조건 CML에 live sync하는 기능
- tool output/file content를 기본 저장하는 기능
- Hermes built-in `session_search`를 대체하려는 기능

### 나중에 만들 것

- Hermes external memory provider plugin
- Hermes upstream session metadata 개선 PR 또는 local patch: `project_path/workdir` 저장
- CML privacy filter 강화 후 tool observation ingestion 확대

---

## 7. 판단

**Hermes 자체만 보면 이미 memory/session_search가 있으므로, Hermes용 live ingestion은 “굳이 지금 필요 없음”에 가깝다.**

하지만 **Claude Code, Codex, Hermes를 같은 프로젝트별 memory backend로 묶고**, 그 위에 **recent context/topic map/ref drill-down**을 제공하는 기능은 Hermes에 이미 있는 기능이 아니므로 만들 가치가 높다.

따라서 제품 방향은 다음 한 문장으로 정리된다.

> claude-memory-layer는 Hermes의 SessionDB를 대체하지 말고, Hermes/Claude/Codex transcript에서 추출한 project-scoped durable context graph와 navigable context pack을 제공하는 MCP memory layer가 되어야 한다.
