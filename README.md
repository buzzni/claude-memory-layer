# Claude Memory Layer

Claude Code 플러그인으로, 대화 내용을 기억하여 사용할수록 똑똑해지는 AI 어시스턴트를 만듭니다.

## 개요

Claude Memory Layer는 Claude Code에서 사용자와 AI 간의 모든 대화를 저장하고, 새로운 질문을 할 때 관련된 과거 대화를 자동으로 검색하여 컨텍스트로 제공합니다. 이를 통해:

- **연속성 있는 대화**: 이전 세션에서 논의한 내용을 기억
- **프로젝트 맥락 이해**: 프로젝트별로 축적된 지식 활용
- **개인화된 응답**: 사용자의 선호도와 패턴 학습

## 빠른 시작 (신규 프로젝트 기준)

아래 순서대로 하면 됩니다.

### 0) 최초 1회(머신 전체) 설치

```bash
cd ~/workspace/claude-memory-layer
npm install
npm run build
npx claude-memory-layer install
```

- `install`은 **한 번만** 하면 됩니다(Claude Code hooks 등록).
- 이후 프로젝트별로 메모리 저장소가 자동 분리됩니다.

### 1) 새 프로젝트에서 초기 메모리 생성

```bash
cd /path/to/your-project
npx claude-memory-layer import
```

- 현재 프로젝트의 기존 Claude 세션(`~/.claude/projects/...`)을 읽어와 메모리로 적재합니다.
- 벡터 임베딩까지 한 번에 처리됩니다.

### 2) 사용 중 확인

```bash
# 프로젝트 메모리 검색
npx claude-memory-layer search "인증 구조"

# 통계 확인
npx claude-memory-layer stats

# 대시보드 실행
npx claude-memory-layer dashboard
```

### 3) 다른 프로젝트에도 동일하게 적용?

네. **완전히 동일한 흐름**을 각 프로젝트에서 반복하면 됩니다.

```bash
cd /path/to/another-project
npx claude-memory-layer import
npx claude-memory-layer search "배포 이슈"
```

프로젝트마다 내부적으로 별도 저장소(`~/.claude-code/memory/projects/<hash>`)를 사용하므로,
기억이 자동으로 분리됩니다.

### 4) 운영 팁

- 특정 프로젝트를 명시하고 싶으면 대부분 명령에 `--project <path>` 사용 가능
- 대규모 리임포트가 필요하면 `import --force` 사용
- 백그라운드 worker가 못 처리한 임베딩은 `process`로 수동 처리
- 상태 점검:
  - `GET /health` (서버 헬스)
  - `GET /api/health` (outbox pending/failed 포함 상세 헬스)
  - `GET /api/stats/retrieval-traces` (검색→컨텍스트 채택 추적)
- 주입 임계값 튜닝(환경변수):
  - `CLAUDE_MEMORY_RETRIEVAL_MODE` (기본 `keyword`, `keyword`/`hybrid`/`semantic`)
  - `CLAUDE_MEMORY_MIN_SCORE` (기본 0.4)
  - `CLAUDE_MEMORY_FALLBACK_MIN_SCORE` (기본 0.3, 결과 0건일 때 재시도)

---

## Features

### Core Features

- **Conversation Memory**: 사용자 프롬프트와 AI 응답 저장
- **Semantic Search**: 벡터 임베딩을 통한 의미 기반 검색
- **AXIOMMIND Architecture**: 7가지 원칙 기반 안정적 메모리 관리
- **Memory Graduation**: L0→L4 단계별 메모리 승격
- **Evidence Alignment**: 응답이 실제 기억에 기반했는지 검증
- **History Import**: 기존 Claude Code 세션 기록 임포트

### Advanced Features

- **Citations System**: 메모리 출처 추적 (`[mem:abc123]` 형식)으로 검색 결과의 원본 확인 가능
- **Endless Mode**: 세션 경계 없는 연속적 메모리 스트림, Biomimetic Memory Architecture 기반
- **Entity-Edge Model**: entries/entities/edges 3-layer 모델로 데이터 관계 명시적 모델링
- **Evidence Aligner V2**: Quote 기반 3단계 정렬 (exact → normalized → fuzzy)
- **MCP Desktop Integration**: Claude Desktop용 MCP 서버로 CLI와 동일한 메모리 공유
- **PostToolUse Hook**: 도구 실행 결과 (Read, Write, Bash 등) 캡처 및 저장
- **Private Tags**: `<private>` 태그로 민감 정보를 명시적으로 제외
- **Progressive Disclosure**: 3-Layer 검색 (인덱스 → 타임라인 → 상세)으로 토큰 효율화
- **memU-inspired Retrieval**: fast/deep 전략 + 스코프 필터(session prefix, canonical key prefix, metadata path)
- **Append-only Markdown Mirror**: 저장 이벤트를 `memory/<namespace>/<category...>/YYYY-MM-DD.md`에도 동기 append (기본값: `namespace=default`, `category=uncategorized`, 경로 세그먼트 sanitize)
  - `memory/_index.md` 인덱스를 자동 갱신
- **Task Entity System**: Task를 Entity로 승격하여 세션 간 상태 추적
- **Vector Outbox V2**: Transactional Outbox 패턴으로 DuckDB-LanceDB 정합성 보장
- **Web Viewer UI**: localhost:37777 대시보드로 실시간 메모리 모니터링

## 설치 방법

### 1. 의존성 설치

```bash
cd claude-memory-layer
npm install
```

### 2. 빌드

```bash
npm run build
```

### 3. Claude Code에 플러그인 등록

빌드된 플러그인을 Claude Code 설정에 추가합니다:

```bash
# Claude Code 설정 디렉토리에 플러그인 복사
cp -r dist/.claude-plugin ~/.claude/plugins/claude-memory-layer/
```

## 사용 방법

### 자동 동작 (Hooks)

플러그인은 Claude Code 세션에 자동으로 연결되어 동작합니다:

| Hook | 동작 |
|------|------|
| **SessionStart** | 세션 시작 시 프로젝트 관련 컨텍스트 로드 |
| **UserPromptSubmit** | 프롬프트 입력 시 관련 기억 검색 및 저장 |
| **Stop** | AI 응답 완료 시 응답 내용 저장 |
| **SessionEnd** | 세션 종료 시 요약 생성 및 저장 |

### Slash 명령어

Claude Code 내에서 사용할 수 있는 명령어:

```bash
# 메모리 검색 - 관련 기억 찾기
/memory-search "authentication 구현 방법"

# 대화 기록 보기
/memory-history
/memory-history --limit 50
/memory-history --session <session-id>

# 통계 확인
/memory-stats

# 기존 대화 기록 임포트
/memory-import                            # 현재 프로젝트
/memory-import --all                      # 모든 프로젝트
/memory-import --project /path/to/project # 특정 프로젝트

# 임포트 가능한 세션 목록
/memory-list

# 메모리 삭제
/memory-forget --session <id> --confirm
```

### 기존 메모리 정리 Import (구조화)

레거시 markdown 메모리를 읽어서 구조화 경로로 재저장(import)할 수 있습니다.

```bash
# 미리보기(실제 저장 없음)
claude-memory-layer organize-import /path/to/legacy-memory --dry-run

# 실제 import
claude-memory-layer organize-import /path/to/legacy-memory --project /path/to/project

# 일부만 import
claude-memory-layer organize-import /path/to/legacy-memory --limit 100

# source에 markdown이 없으면 자동 bootstrap(코드+git 분석)
claude-memory-layer organize-import /path/to/empty-dir --project /path/to/project

# bootstrap 강제 실행
claude-memory-layer organize-import /path/to/memory --force-bootstrap --repo /path/to/project

# 자동 bootstrap 비활성화
claude-memory-layer organize-import /path/to/empty-dir --no-bootstrap-if-empty

# markdown이 없는 초기 상태면 bootstrap 생성 + import
claude-memory-layer organize-import /path/to/empty-dir --bootstrap --repo /path/to/codebase

# bootstrap 강제 재생성 (기존 markdown 있어도)
claude-memory-layer organize-import /path/to/legacy-memory --force-bootstrap --repo /path/to/codebase --out /path/to/legacy-memory/bootstrap-kb

# 증분 bootstrap (기본값): 이전 manifest를 기준으로 변경분 중심 업데이트
claude-memory-layer organize-import /path/to/legacy-memory --bootstrap --repo /path/to/codebase --incremental

# 전체 재생성 bootstrap
claude-memory-layer organize-import /path/to/legacy-memory --bootstrap --repo /path/to/codebase --no-incremental
```

### CLI 명령어

터미널에서 직접 사용:

```bash
# 메모리 검색
npx claude-memory-layer search "React 컴포넌트 패턴"
npx claude-memory-layer search "API 에러 처리" --top-k 10

# 대화 기록 조회
npx claude-memory-layer history
npx claude-memory-layer history --limit 50 --type user_prompt

# 통계 확인
npx claude-memory-layer stats

# 기존 세션 임포트
npx claude-memory-layer import                    # 현재 프로젝트
npx claude-memory-layer import --all              # 모든 프로젝트
npx claude-memory-layer import --all --verbose    # 상세 로그

# 임포트 가능한 세션 목록
npx claude-memory-layer list
npx claude-memory-layer list --project /path/to/project

# 임베딩 수동 처리
npx claude-memory-layer process

# MongoDB 동기화 (옵션, 멀티 서버 협업)
# - 여러 서버에서 같은 프로젝트를 개발할 때, 각 서버의 로컬 SQLite(events.sqlite) 이벤트를
#   하나의 MongoDB로 모아 push/pull 동기화할 수 있습니다.
# - 동일 프로젝트는 반드시 같은 project key로 실행해야 합니다.
export CLAUDE_MEMORY_MONGO_URI="mongodb://USER:PASSWORD@HOST:PORT/"
export CLAUDE_MEMORY_MONGO_DB="claude_memory_layer"
export CLAUDE_MEMORY_MONGO_PROJECT="my-project"

# 1회 동기화 (push+pull)
npx claude-memory-layer mongo-sync

# 지속 동기화 (주기적으로 push+pull)
npx claude-memory-layer mongo-sync --watch --interval 30000
```

### memU-inspired Retrieval 사용 예시

아래 예시는 SDK/서비스 레벨에서 `retrieveMemories()` 호출 시 적용되는 옵션입니다.

```ts
import { getMemoryServiceForProject } from './src/services/memory-service.js';

const memory = getMemoryServiceForProject('/path/to/project');

// 1) Fast: 키워드 기반 빠른 검색
const fast = await memory.retrieveMemories('브리핑 포맷', {
  strategy: 'fast',
  topK: 5,
  minScore: 0.6
});

// 2) Deep: 벡터 검색 + 키워드 오버랩 재정렬
const deep = await memory.retrieveMemories('브리핑 포맷', {
  strategy: 'deep',
  topK: 10,
  rerankWithKeyword: true
});

// 3) Scoped filter: 세션/타입/계층형 메타데이터로 범위 제한
const scoped = await memory.retrieveMemories('아침 브리핑', {
  strategy: 'deep',
  scope: {
    sessionIdPrefix: 'agent:main:',
    eventTypes: ['user_prompt', 'agent_response'],
    canonicalKeyPrefix: 'pref/briefing',
    contentIncludes: ['아침'],
    metadata: {
      'scope.project.id': 'alpha'
    }
  }
});
```

팁:
- `strategy: 'auto'`는 기본적으로 fallback 체인을 사용해 결과를 찾습니다.
- 저지연 응답이 중요하면 `fast`, 정확도 우선이면 `deep`를 권장합니다.
- 프로젝트 서비스(`getMemoryServiceForProject`) 기준 검색 스코프는 기본적으로 project-aware(엄격 모드)로 동작합니다.

## Privacy 기능

### Private Tags

민감한 정보를 메모리에서 제외하려면 `<private>` 태그를 사용합니다:

```markdown
이 부분은 저장됩니다.

<private>
API_KEY=sk-xxxx
SECRET_TOKEN=abc123
이 내용은 메모리에 저장되지 않습니다.
</private>

이 부분도 저장됩니다.
```

저장 결과:
```
이 부분은 저장됩니다.
[PRIVATE]
이 부분도 저장됩니다.
```

### 자동 필터링

다음 패턴은 자동으로 마스킹됩니다:
- `password`, `api_key`, `secret`, `token`
- Bearer 토큰
- Private Key 블록

## Citations (인용 시스템)

검색 결과에는 인용 ID가 포함됩니다:

```
🔍 Search Results:

#1 [mem:a7Bc3x] (score: 0.94)
   "DuckDB를 사용하여 이벤트 소싱 패턴을..."
   📅 2026-01-30 | 🔗 Session abc123
```

원본 확인:
```bash
claude-memory-layer show mem:a7Bc3x
```

## Endless Mode

세션 경계 없이 연속적인 메모리 스트림을 유지합니다:

```bash
# Endless Mode 활성화
claude-memory-layer config set mode endless

# 상태 확인
claude-memory-layer status

# 출력 예시:
# Mode: Endless
# Working Set: 47 events (last 18 hours)
# Continuity Score: 0.85 (seamless)
# Consolidated: 23 memories
```

### 모드 비교

| 기존 세션 모드 | Endless Mode |
|---------------|-------------|
| 명확한 시작/끝 | 연속적 스트림 |
| 세션별 요약 | 점진적 통합 |
| 재시작 시 빈 상태 | 이전 컨텍스트 유지 |

## MCP Desktop Integration

Claude Desktop에서 메모리 검색을 사용하려면:

```bash
# MCP 서버 설치
claude-memory-layer mcp install

# 또는 수동 설정: ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "claude-memory-layer": {
      "command": "npx",
      "args": ["claude-memory-layer-mcp"]
    }
  }
}
```

### 제공되는 MCP 도구

| 도구 | 설명 |
|------|------|
| `mem-search` | 메모리 검색 |
| `mem-timeline` | 타임라인 조회 |
| `mem-details` | 상세 정보 조회 |
| `mem-stats` | 통계 조회 |

## Web Viewer

브라우저에서 메모리 대시보드를 확인할 수 있습니다:

```bash
# 웹 서버 시작
claude-memory-layer dashboard

# 브라우저에서 접속
# http://localhost:37777
```

### 주요 기능
- 실시간 이벤트 스트림
- 세션/프로젝트별 탐색
- 벡터 검색 인터페이스
- 저장소 통계 대시보드
- Outbox 상태 모니터링
- Retrieval Trace (검색 질의 → 후보/채택 수 → 최종 context 채택 IDs) 1:1 확인
- 채택된 event ID 클릭으로 상세 모달 확인 + score breakdown(semantic/lexical/recency) 확인
- 후보(candidate) event ID 스냅샷도 함께 노출되어 검색→채택 전 과정을 추적 가능

## 기존 대화 기록 임포트

이미 Claude Code를 사용해왔다면, 기존 대화 기록을 임포트하여 바로 활용할 수 있습니다:

```bash
# 1. 먼저 임포트 가능한 세션 확인
npx claude-memory-layer list

# 2. 현재 프로젝트의 모든 세션 임포트
npx claude-memory-layer import

# 3. 또는 모든 프로젝트의 세션 임포트
npx claude-memory-layer import --all --verbose
```

### 임포트 결과 예시

```
📥 Importing all sessions from all projects

⏳ Processing embeddings...

✅ Import Complete

Sessions processed: 15
Total messages: 342
Imported prompts: 156
Imported responses: 186
Skipped duplicates: 0
Embeddings processed: 342
```

### 중복 처리

임포트는 콘텐츠 해시 기반으로 중복을 자동 감지합니다. 여러 번 실행해도 같은 내용이 중복 저장되지 않습니다.

## 동작 원리

### 1. 메모리 저장

```
사용자 프롬프트 입력
        ↓
    EventStore에 저장 (DuckDB, append-only)
        ↓
    Outbox에 임베딩 요청 등록
        ↓
    Vector Worker가 임베딩 생성
        ↓
    VectorStore에 저장 (LanceDB)
```

### 2. 메모리 검색

```
새 프롬프트 입력
        ↓
    임베딩 생성
        ↓
    VectorStore에서 유사 벡터 검색
        ↓
    AXIOMMIND Matcher로 신뢰도 계산
        ↓
    컨텍스트로 Claude에 제공
```

### 3. 메모리 승격 (Graduation)

자주 참조되는 메모리는 더 높은 레벨로 승격됩니다:

| Level | 이름 | 설명 | 승격 조건 |
|-------|------|------|-----------|
| L0 | EventStore | 원본 이벤트 | 기본 저장 |
| L1 | Structured | 구조화된 패턴 | 3회 이상 접근 |
| L2 | Candidates | 검증된 스키마 | 5회 이상, 다중 세션 참조 |
| L3 | Verified | 교차 검증됨 | 높은 신뢰도 |
| L4 | Active | 활성 지식 | 10회 이상, 3개 이상 세션 |

## 매칭 신뢰도

검색 결과는 신뢰도에 따라 분류됩니다:

| 신뢰도 | 점수 | Gap | 동작 |
|--------|------|-----|------|
| **High** | ≥0.92 | ≥0.03 | 자동으로 컨텍스트에 포함 |
| **Suggested** | ≥0.75 | <0.03 | 대안 제시 |
| **None** | <0.75 | - | 매칭 없음 |

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code Hooks                       │
│  SessionStart │ UserPromptSubmit │ Stop │ PostToolUse │ End │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Memory Service                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Retriever  │  │   Matcher   │  │  Graduation │         │
│  │  Progressive│  │   Evidence  │  │   L0 → L4   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                      ▼
┌───────────────┐                    ┌───────────────┐
│  EventStore   │ ──── Outbox ────▶ │  VectorStore  │
│   (DuckDB)    │    (V2 Pattern)   │   (LanceDB)   │
└───────────────┘                    └───────────────┘
```

### Entity-Edge Model (3-Layer)

```
┌─────────────────────────────────────────────────────────────┐
│                        edges                                 │
│  ┌──────────┐    evidence_of    ┌──────────┐               │
│  │  Entry   │ ─────────────────▶│  Entity  │               │
│  │ (Fact,   │                   │ (Task,   │               │
│  │ Decision)│                   │ Artifact)│               │
│  └──────────┘                   └──────────┘               │
│       │                              │                       │
│       │ derived_from                 │ blocked_by           │
│       ▼                              ▼                       │
│  ┌──────────┐                   ┌──────────┐               │
│  │  Entry   │                   │  Entity  │               │
│  └──────────┘                   └──────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### Progressive Disclosure (토큰 효율화)

```
Layer 1: Search Index (~50-100 tokens/result)
    │     { id, summary, score }
    │
    └──▶ Layer 2: Timeline Context (~200 tokens)
              │     시간순 전후 맥락
              │
              └──▶ Layer 3: Full Details (~500-1000 tokens)
                        선택된 항목만 전체 로드
```

### MCP Integration

```
┌─────────────────────┐         ┌─────────────────────┐
│   Claude Desktop    │◀────────│ claude-memory-layer │
│   (MCP Client)      │  stdio  │    (MCP Server)     │
└─────────────────────┘         └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │   Shared Storage    │
                                │  ~/.claude-code/    │
                                └─────────────────────┘
```

## AXIOMMIND 7 원칙

1. **Single Source of Truth**: DuckDB EventStore가 유일한 진실의 원천
2. **Append-Only**: 이벤트는 수정/삭제 없이 추가만
3. **Idempotency**: dedupe_key로 중복 이벤트 감지
4. **Evidence Alignment**: 주장이 실제 소스에 기반했는지 검증
5. **Entity-Based Tasks**: canonical_key로 일관된 엔티티 식별
6. **Vector Store Consistency**: DuckDB → LanceDB 단방향 흐름
7. **Standard JSON**: 모든 데이터는 이식 가능한 JSON 형식

## 저장 위치

메모리는 기본적으로 다음 위치에 저장됩니다:

```
~/.claude-code/memory/
├── projects/<hash>/events.sqlite  # 프로젝트별 이벤트 저장소 (primary)
├── projects/<hash>/vectors/        # 프로젝트별 벡터 임베딩
└── shared/                         # (옵션) 공유 지식 저장소
```

Claude Code 세션 기록 위치:

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

## 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 테스트
npm test

# 타입 체크
npm run typecheck

# 개발 모드 실행
npm run dev
```

## 기술 스택

- **DuckDB**: 이벤트 저장소 (append-only SQL)
- **LanceDB**: 벡터 저장소 (고성능 벡터 검색)
- **@xenova/transformers**: 로컬 임베딩 생성
- **Zod**: 런타임 타입 검증
- **Commander**: CLI 인터페이스
- **TypeScript**: 타입 안전한 코드
- **Bun**: HTTP 서버 (Web Viewer)
- **Hono**: 경량 라우터
- **MCP SDK**: Claude Desktop 통합

## Specification Documents

상세 설계 문서는 `specs/` 디렉토리에서 확인할 수 있습니다:

| 문서 | 설명 |
|------|------|
| [citations-system](specs/citations-system/spec.md) | 메모리 인용 시스템 |
| [endless-mode](specs/endless-mode/spec.md) | 연속 세션 모드 |
| [entity-edge-model](specs/entity-edge-model/spec.md) | 3-Layer 데이터 모델 |
| [evidence-aligner-v2](specs/evidence-aligner-v2/spec.md) | 증거 정렬 시스템 |
| [mcp-desktop-integration](specs/mcp-desktop-integration/spec.md) | MCP 서버 통합 |
| [post-tool-use-hook](specs/post-tool-use-hook/spec.md) | 도구 사용 기록 |
| [private-tags](specs/private-tags/spec.md) | 프라이버시 태그 |
| [progressive-disclosure](specs/progressive-disclosure/spec.md) | 토큰 효율화 검색 |
| [task-entity-system](specs/task-entity-system/spec.md) | Task Entity 관리 |
| [vector-outbox-v2](specs/vector-outbox-v2/spec.md) | Transactional Outbox |
| [web-viewer-ui](specs/web-viewer-ui/spec.md) | 웹 대시보드 |

## Roadmap

### Phase 1: Core (완료)
- [x] Event Store (DuckDB)
- [x] Vector Store (LanceDB)
- [x] Memory Graduation (L0→L4)
- [x] Evidence Alignment
- [x] History Import

### Phase 2: Advanced Features (진행 중)
- [ ] Citations System
- [ ] Endless Mode
- [ ] Entity-Edge Model
- [ ] Evidence Aligner V2
- [ ] Private Tags

### Phase 3: Integration
- [ ] MCP Desktop Integration
- [ ] Web Viewer UI
- [ ] PostToolUse Hook
- [ ] Progressive Disclosure

### Phase 4: Optimization
- [ ] Vector Outbox V2
- [ ] Task Entity System
- [ ] Performance Tuning

## License

MIT
