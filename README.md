# Claude Memory Layer

Claude Code, Codex, Hermes, MCP 클라이언트가 함께 쓰는 **프로젝트 스코프 메모리 레이어**입니다. 대화/세션 기록을 SQLite 이벤트 저장소와 LanceDB 벡터 인덱스로 관리하고, 작업 시작 시 필요한 기억·타임라인·액션 프런티어를 privacy-safe 컨텍스트로 제공합니다.

## 개요

Claude Memory Layer는 AI 에이전트의 대화와 작업 이벤트를 프로젝트별로 저장하고, 새로운 작업을 시작할 때 관련 기억을 자동 검색해 컨텍스트로 제공합니다. 최신 npm 패키지는 단순 Claude Code hook을 넘어 다음 용도로 사용할 수 있습니다:

- **연속성 있는 대화**: 이전 세션에서 논의한 결정, 오류, 검증 결과를 검색
- **프로젝트 맥락 이해**: 프로젝트별 isolated store와 `projectPath` 기반 MCP/CLI 조회
- **다중 에이전트 호환**: Claude Code hooks + Codex/Hermes session import + MCP stdio server
- **운영형 메모리**: actions/frontier/checkpoints/facets/lessons/retention audit로 다음 작업을 이어받기
- **Perspective Memory**: 사용자/어시스턴트/서브에이전트 관점의 actor card와 observation 관리
- **신뢰 가능한 벡터 동기화**: Vector Outbox V2, worker lock, dashboard/vector-status health로 누락 복구

## 최신 릴리스 하이라이트

- **MCP Context Navigator**: `mem-context-pack`, `mem-project-timeline`, `mem-source-ref`, `mem-import-latest`로 Hermes/Codex/Claude Desktop이 같은 프로젝트 기억을 안전하게 조회합니다.
- **Memory Operations Layer**: facet/action/frontier/checkpoint/retention/graph/lesson 도구와 CLI가 추가되어 “무엇을 다음에 해야 하는가”를 메모리에서 바로 복원합니다.
- **Honcho-inspired Perspective Memory**: actor/session membership, actor cards, perspective observations, contradiction/derived observation, perspective context/query 도구를 제공합니다.
- **Vector Outbox V2**: SQLite source write와 vector enqueue를 같은 트랜잭션으로 묶고, versioned LanceDB upsert와 stuck-job recovery를 지원합니다.
- **Dashboard 운영성 강화**: local-only 기본 bind, 선택적 password gate, Vector Health 카드, Perspective Memory aggregate 카드, retrieval trace/score breakdown을 제공합니다.
- **Codex/Hermes history ingest**: 원본 세션은 read-only validate/replay로 먼저 확인하고, 명시적 import로만 프로젝트 메모리에 반영합니다.
- **Hermes/CML/Headroom 운영 모델**: Hermes built-in memory, `session_search`, CML context-pack, read-only Hermes provider, Headroom reference stance는 [`docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md`](docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md)에 정리되어 있습니다.
- **npm 설치 안정화**: `@huggingface/transformers`는 optional dependency + postinstall repair로 설치하며, CUDA 11 환경에서는 CPU-only ONNX Runtime으로 자동 복구합니다.

## 빠른 시작 (신규 프로젝트 기준)

아래 순서대로 하면 됩니다.

### 0) 최초 1회(머신 전체) 설치

권장 설치 방식은 npm에 배포된 패키지를 **전역 설치**하는 것입니다. `install`은 Claude Code hook 파일 경로를 `~/.claude/settings.json`에 저장하므로, 일회성 `npx claude-memory-layer install`보다 전역 설치 또는 고정된 로컬 checkout을 쓰는 것이 안전합니다.

```bash
npm install -g claude-memory-layer@latest
claude-memory-layer install
claude-memory-layer status
```

로컬 개발 checkout에서 설치할 때:

```bash
git clone https://github.com/buzzni/claude-memory-layer.git
cd claude-memory-layer
npm install
npm run build
npx claude-memory-layer install
npx claude-memory-layer status
```

- `install`은 **한 번만** 하면 됩니다(Claude Code hooks 등록).
- Embedding backend은 런타임 필수 기능이지만, npm 설치 단계에서는 `optionalDependencies` + postinstall repair로 처리합니다. CUDA 11 환경에서 `onnxruntime-node`의 GPU 바이너리 자동 설치가 실패해도 패키지 설치 자체를 살리고 CPU-only backend로 복구하기 위해서입니다.
- 이후 프로젝트별로 메모리 저장소가 자동 분리됩니다.
- `install` / `uninstall`은 `~/.claude/settings.json`을 수정합니다.

#### CUDA 11 / `onnxruntime-node` 설치 에러

Linux x64 서버에 CUDA 11이 설치되어 있으면 `@huggingface/transformers`의 하위 의존성인 `onnxruntime-node`가 `nvcc --version`을 감지한 뒤 CUDA 11용 GPU 바이너리를 자동 설치하려고 합니다. 현재 해당 install script는 CUDA 11 자동 설치를 지원하지 않아 다음 오류로 `npm install`이 실패할 수 있습니다.

```text
Error: CUDA 11 binaries are not supported by this script yet.
```

Claude Memory Layer는 로컬 semantic/vector embedding에 필요한 `@huggingface/transformers`를 런타임 필수 backend로 취급합니다. 다만 CUDA 11 환경에서 하위 의존성 설치가 먼저 실패하는 문제를 피하려고 npm dependency level에서는 optional로 두고, 설치 중 postinstall repair가 `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`으로 CPU-only ONNX Runtime을 자동 복구합니다. npm 로그에 `onnxruntime-node`의 CUDA 11 stack trace가 보이더라도 최종 exit code가 0이고 `claude-memory-layer --version`이 동작하면 정상입니다. 최신 버전에서는 일반적으로 아래 명령이 그대로 동작해야 합니다.

```bash
npm install -g claude-memory-layer@latest
claude-memory-layer --version
```

만약 npm 버전/환경 차이로 같은 오류가 계속 나면 아래처럼 CUDA 바이너리 다운로드를 명시적으로 건너뛰어 재설치하세요.

```bash
# 실패한 전역 설치가 일부 남아 있으면 먼저 제거
npm uninstall -g claude-memory-layer || true

# CPU-only ONNX Runtime으로 재설치
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest
claude-memory-layer --version
```

로컬 checkout 개발 환경에서 같은 오류가 나면 아래처럼 설치합니다.

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
```

이미 설치된 패키지 디렉터리에서 backend만 손상/누락된 경우에는 postinstall repair와 런타임 오류 메시지가 동일한 CPU-only 복구 명령을 안내합니다.

`npm warn deprecated ...` 경고는 하위 의존성 경고이며 설치 실패 원인이 아닙니다.

#### Embedding model

기본 로컬 embedding 모델은 `Xenova/multilingual-e5-small`입니다.

- `@huggingface/transformers`/ONNX Runtime CPU에서 동작하므로 CUDA가 필요 없습니다.
- 원본 `intfloat/multilingual-e5-small`은 multilingual + Korean(`ko`) 지원 모델이고, Xenova variant는 Transformers.js용 ONNX 파일을 제공합니다.
- 384차원이라 대규모 세션 import에서도 CPU/메모리 부담이 작습니다.
- 더 높은 품질이 필요하면 `--embedding-model <hf-model>` 또는 `CLAUDE_MEMORY_EMBEDDING_MODEL`로 `onnx-community/Qwen3-Embedding-0.6B-ONNX`, `onnx-community/embeddinggemma-300m-ONNX` 같은 Transformers.js/ONNX 모델을 실험할 수 있습니다. 다만 이들은 다운로드/CPU 비용이 더 크거나 모델/라이선스 성숙도를 별도 검토해야 합니다.

```bash
claude-memory-layer import --project "$PWD" --embedding-model Xenova/multilingual-e5-small
CLAUDE_MEMORY_EMBEDDING_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX claude-memory-layer process --project "$PWD"
```

### 1) 새 프로젝트에서 초기 메모리 생성

```bash
cd /path/to/your-project
claude-memory-layer import
```

- 현재 프로젝트의 기존 Claude Code 세션(`~/.claude/projects/...`)을 읽어와 메모리로 적재합니다.
- 벡터 임베딩까지 한 번에 처리됩니다.

### 2) 사용 중 확인

```bash
# 프로젝트 메모리 검색
claude-memory-layer search "인증 구조"

# 통계 확인
claude-memory-layer stats

# 대시보드 실행
claude-memory-layer dashboard --no-open
```

### 3) 다른 프로젝트에도 동일하게 적용?

네. **완전히 동일한 흐름**을 각 프로젝트에서 반복하면 됩니다.

```bash
cd /path/to/another-project
claude-memory-layer import
claude-memory-layer search "배포 이슈"
```

프로젝트마다 내부적으로 별도 저장소(`~/.claude-code/memory/projects/<hash>`)를 사용하므로,
기억이 자동으로 분리됩니다.

### 4) 운영 팁

- 특정 프로젝트를 명시하고 싶으면 대부분 명령에 `--project <path>` 사용 가능
- 대규모 리임포트가 필요하면 `import --force` 사용
- 최근 일부만 가져오고 싶으면 `--session-limit <n>` 또는 `--limit <n>` 사용
- 백그라운드 worker가 못 처리한 임베딩은 `process`로 수동 처리
- 상태 점검:
  - `GET /health` (서버 헬스)
  - `GET /api/health` (outbox pending/failed 포함 상세 헬스)
  - `GET /api/stats/retrieval-traces` (검색→컨텍스트 채택 추적)
- 주입 임계값 튜닝(환경변수):
  - `CLAUDE_MEMORY_RETRIEVAL_MODE` (기본 `hybrid`, `keyword`/`hybrid`/`semantic`)
  - `CLAUDE_MEMORY_SEMANTIC_DAEMON_IDLE_MS` (기본 `600000`, semantic daemon 유휴 종료 시간)
  - `CLAUDE_MEMORY_MIN_SCORE` (기본 0.4)
  - `CLAUDE_MEMORY_FALLBACK_MIN_SCORE` (기본 0.3, 결과 0건일 때 재시도)

---

## 다른 서버 초기 세팅 & 이전 대화 ingest

새 서버에서 Claude Memory Layer를 설치하고 기존 Claude Code/Codex/Hermes 대화 기록을 처음 적재할 때는 아래 체크리스트를 따르세요.

### 1) 새 서버 준비

```bash
node --version   # Node.js >= 18 필수
npm --version
npm install -g claude-memory-layer@latest
claude-memory-layer install
claude-memory-layer status
```

> `claude-memory-layer install`은 Claude Code hooks를 등록합니다. 이미 Claude Code가 실행 중이면 재시작해야 hook이 반영됩니다.

### 2) 이전 서버의 원본 대화 기록 가져오기

가장 안전한 방식은 **원본 대화 기록을 새 서버로 복사한 뒤 새 서버에서 다시 import**하는 것입니다. 필요한 것만 선택해서 복사하세요. 이 디렉토리/DB에는 민감한 대화와 경로가 포함될 수 있으므로 공개 저장소에 커밋하거나 공유하지 말고, SSH/사설망 등 신뢰할 수 있는 경로로만 복사하세요.

```bash
# Claude Code 원본 세션(JSONL)
mkdir -p ~/.claude/projects
rsync -a OLD_HOST:~/.claude/projects/ ~/.claude/projects/

# Codex CLI 원본 세션(JSONL) - Codex 기록도 가져올 때만
mkdir -p ~/.codex/sessions
rsync -a OLD_HOST:~/.codex/sessions/ ~/.codex/sessions/

# Hermes Agent SessionDB - Hermes 기록도 가져올 때만
# 권장: OLD_HOST에서 Hermes/gateway/agent 프로세스를 먼저 멈춘 뒤 SQLite sidecar까지 함께 복사
mkdir -p ~/.hermes
rsync -a OLD_HOST:'~/.hermes/state.db*' ~/.hermes/
```

Hermes를 멈출 수 없는 운영 서버라면, `state.db` 파일을 직접 복사하는 대신 OLD_HOST에서 SQLite `.backup`으로 일관된 스냅샷을 만든 뒤 가져오세요.

```bash
ssh OLD_HOST 'sqlite3 ~/.hermes/state.db ".backup /tmp/hermes-state.db.backup"'
mkdir -p ~/.hermes
rsync -a OLD_HOST:/tmp/hermes-state.db.backup ~/.hermes/state.db
```

이미 처리된 CML 저장소를 그대로 옮기고 싶다면, 이전/새 서버의 관련 agent, dashboard, semantic daemon/worker 등 모든 CML writer를 멈춘 뒤 아래처럼 복사할 수도 있습니다. 단, 재현성과 모델/버전 migration을 위해서는 위의 원본 기록 re-ingest 방식을 우선 권장합니다.

```bash
mkdir -p ~/.claude-code
rsync -a OLD_HOST:~/.claude-code/memory/ ~/.claude-code/memory/
```

### 3) 프로젝트별로 read-only 검증 후 import

프로젝트 메모리는 프로젝트 경로 기준으로 분리됩니다. 새 서버의 실제 repo 경로를 `PROJECT`에 넣고, 필요한 importer만 실행하세요.

중요: Codex/Hermes/Claude Code 원본 세션의 project filter는 **대화가 생성될 당시의 절대 경로**를 기준으로 매칭합니다. 새 서버에서도 repo 절대 경로가 이전 서버와 같으면 아래 project import를 그대로 쓰면 됩니다.

```bash
export PROJECT=/path/to/your-project
cd "$PROJECT"

# Claude Code 기록: import 가능한 세션 확인 후 프로젝트 메모리로 적재
claude-memory-layer list --project "$PROJECT"
claude-memory-layer import --project "$PROJECT" --verbose

# Codex 기록: 먼저 읽기 전용 리포트로 확인한 뒤 명시적으로 import
claude-memory-layer codex validate --project "$PROJECT" --format markdown
claude-memory-layer codex import --project "$PROJECT" --verbose

# Hermes 기록: 먼저 읽기 전용 리포트로 확인한 뒤 명시적으로 import
claude-memory-layer hermes validate --project "$PROJECT" --format markdown
claude-memory-layer hermes import --project "$PROJECT" --verbose

# pending embedding이 남아 있으면 수동 처리
claude-memory-layer process --project "$PROJECT"
```

이전 서버와 새 서버의 repo 절대 경로가 다르면, `OLD_PROJECT`로 원본 세션을 찾고 특정 session 파일/id를 새 프로젝트 저장소(`NEW_PROJECT`)로 가져오세요.

```bash
export OLD_PROJECT=/old/server/path/to/your-project
export NEW_PROJECT=/path/to/your-project
cd "$NEW_PROJECT"

# Claude Code: list 출력의 JSONL session file path를 확인해서 사용
claude-memory-layer list --project "$OLD_PROJECT"
claude-memory-layer import --project "$NEW_PROJECT" --session /path/to/claude-session.jsonl --verbose

# Codex: validate 결과에서 session JSONL 파일을 확인한 뒤 import
claude-memory-layer codex validate --project "$OLD_PROJECT" --format markdown
claude-memory-layer codex import --project "$NEW_PROJECT" --session /path/to/codex-session.jsonl --verbose

# Hermes: validate 결과에서 Hermes session id를 확인한 뒤 import
claude-memory-layer hermes validate --project "$OLD_PROJECT" --format markdown
claude-memory-layer hermes import --project "$NEW_PROJECT" --session 20260505_010203_abcd1234 --verbose

claude-memory-layer process --project "$NEW_PROJECT"
```

주의:

- `claude-memory-layer import --all`은 모든 Claude Code 세션을 전역 저장소로 가져옵니다. 프로젝트별 컨텍스트 품질이 중요하면 각 repo에서 `--project <path>` 방식으로 반복하는 것을 권장합니다.
- `codex import --all`, `hermes import --all`도 의도적으로 전역 메모리를 만들 때만 사용하세요.
- import/validate/list 결과에는 대화 내용 일부나 로컬 경로가 포함될 수 있습니다. 외부 공유 전에는 민감정보와 경로를 제거하고, Codex validate 리포트는 필요하면 `--anonymize-projects`를 함께 사용하세요.
- import는 콘텐츠 해시 기반으로 중복을 건너뛰므로 여러 번 실행해도 같은 내용이 중복 저장되지 않습니다. 단, `--force`는 기존 import 이벤트를 지우고 재적재하므로 신중히 사용하세요.

### 4) 검증

```bash
export VERIFY_PROJECT=/path/to/your-project  # 위에서 쓴 PROJECT 또는 NEW_PROJECT
claude-memory-layer stats --project "$VERIFY_PROJECT"
claude-memory-layer search "최근에 하던 작업" --project "$VERIFY_PROJECT" --top-k 5
claude-memory-layer dashboard --no-open --port 37777
# 다른 터미널에서: curl http://localhost:37777/api/health
```

### 5) MCP/다른 agent에 연결

Claude Desktop은 CLI로 자동 등록할 수 있습니다. GUI 앱에서 shell `PATH`가 다를 수 있으면 stdio binary의 절대 경로를 command로 넣는 방식이 더 견고합니다.

```bash
claude-memory-layer mcp install --command "$(command -v claude-memory-layer-mcp)"
# Claude Desktop 재시작
```

Codex/Hermes 등 MCP client에도 전역 설치된 stdio binary를 등록하면 됩니다.

```bash
# Codex 예시
codex mcp add claude-memory-layer -- claude-memory-layer-mcp

# Hermes 예시
hermes mcp add claude-memory-layer --command claude-memory-layer-mcp
```

MCP client가 환경에 따라 PATH를 못 찾으면 `command -v claude-memory-layer-mcp`로 절대 경로를 확인해서 command에 넣으세요.

---

## Features

### Core Features

- **Project-scoped Conversation Memory**: Claude Code, Codex, Hermes의 user/assistant turn을 프로젝트별 SQLite store에 저장
- **Hybrid Retrieval**: keyword/semantic/auto 전략, progressive disclosure, source/citation drill-down
- **MCP Context Navigator**: 작업 시작용 compact context pack + recent project timeline + privacy-safe source refs
- **Memory Operations**: facets, actions, frontier, checkpoints, retention audit, graph query, procedural lessons
- **Perspective Memory**: actor list, actor card, observer→observed observations, contradiction/derived lanes
- **Vector Outbox V2**: transactional enqueue, versioned vector upsert, worker lock, stuck recovery, aggregate health
- **Dashboard**: localhost dashboard, retrieval trace, Vector Health, Perspective Memory aggregate panels
- **External Context**: DART/FRED/Finnhub read-only market context snapshot for research/analysis workflows

### Advanced Features

- **Citations System**: 검색 결과를 `[mem:abc123]` 형태로 추적하고 `source`/`mem-source-ref`로 근거 확인
- **Source Neighbor Expansion**: `mem-source-ref(includeNeighbors=true, neighborWindow=1..5)`로 MemPalace식 hit 주변 세션 이벤트를 privacy-safe preview로 함께 확인
- **Progressive Disclosure**: index → timeline → details 순서로 필요한 만큼만 확장해 토큰 비용 절감
- **Codex/Hermes Importers**: read-only validate/replay 후 explicit import로만 mutation 수행
- **Perspective Query Agent**: 관점별 observation + raw memory를 읽기 전용으로 조합하고 source refs를 유지
- **Governance Audit**: facet/action/checkpoint/perspective mutation은 actor/evidence metadata와 함께 기록
- **Privacy Guardrails**: `<private>` 태그, credential/path redaction, aggregate-only dashboard/API/CLI 출력
- **Append-only Markdown Mirror**: 선택적으로 저장 이벤트를 `memory/<namespace>/.../YYYY-MM-DD.md`에 append
- **Mongo Sync**: 멀티 서버 협업을 위한 선택적 이벤트 push/pull sync
- **Endless Mode / Shared Memory**: 세션 경계 없는 연속 기억 및 공유 store 실험 기능

### 현재 feature status

| 영역 | 상태 | 비고 |
|------|------|------|
| Claude Code hooks / CLI | Stable | `install`, `search`, `import`, `stats`, `dashboard`, `process` |
| SQLite event store / project registry | Stable | 프로젝트별 canonical source of truth, WAL 기반 동시 읽기/쓰기 |
| LanceDB vector index / Embedder | Stable accelerator | `@huggingface/transformers` optional + postinstall repair, versioned vector tables |
| Vector Outbox V2 | Implemented | transactional enqueue, worker lock, stale recovery, `vector-status`, dashboard Vector Health |
| Progressive disclosure / retrieval traces | Implemented | `search --disclosure`, `expand`, `source`, score breakdown, privacy-safe lanes |
| MCP server | Implemented | package bin `claude-memory-layer-mcp`, project-aware read tools + audited operation tools |
| Codex/Hermes session ingestion | Implemented | validate/replay는 read-only, import는 명시적 mutation |
| Memory Operations layer | Implemented | facets/actions/frontier/checkpoints/retention/graph/lessons |
| Perspective Memory | Implemented P0/P1 | actors, actor cards, perspective observations, context-pack lanes, aggregate dashboard |
| Dashboard | Implemented | local-only default bind, optional password, vector/perspective/trace panels |
| External Market Context | Implemented | DART/FRED/Finnhub read-only snapshot + MCP tool |
| Mongo sync / Endless mode / shared memory | Experimental | 고급/운영 옵션으로 취급 |

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

Claude Code hook 설정은 CLI가 등록합니다:

```bash
npx claude-memory-layer install
```

> 주의: `install` / `uninstall`은 `~/.claude/settings.json`을 수정합니다. 자동 테스트나 임의 실행 대신, 실제 사용자가 설치/해제를 원할 때만 실행하세요.

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

전역 설치 후에는 `claude-memory-layer`를 그대로 쓰고, 로컬 checkout에서는 `npx claude-memory-layer` 또는 `node dist/cli/index.js`를 사용할 수 있습니다.

```bash
# 메모리 검색 / progressive disclosure
claude-memory-layer search "React 컴포넌트 패턴" --top-k 10
claude-memory-layer search "API 에러 처리" --disclosure
claude-memory-layer expand mem:abc123
claude-memory-layer source mem:abc123

# 대화 기록 / 통계
claude-memory-layer history --limit 50 --type user_prompt
claude-memory-layer stats --project /path/to/project

# Claude Code 세션 import
claude-memory-layer list --project /path/to/project
claude-memory-layer import --project /path/to/project --verbose

# Codex/Hermes 세션은 read-only 검증 후 명시적으로 import
claude-memory-layer codex validate --project /path/to/project --format markdown --anonymize-projects
claude-memory-layer codex import --project /path/to/project --verbose
claude-memory-layer hermes validate --project /path/to/project --format markdown
claude-memory-layer hermes import --project /path/to/project --verbose

# 임베딩/벡터 outbox 처리와 상태 점검
claude-memory-layer process --project /path/to/project
claude-memory-layer process --project /path/to/project --dry-run-recovery
claude-memory-layer vector-status --project /path/to/project

# Perspective Memory actor/session membership backfill
claude-memory-layer actors repair --project /path/to/project --dry-run
claude-memory-layer actors repair --project /path/to/project --apply

# Memory Operations
claude-memory-layer facet query --project /path/to/project --dimension workflow
claude-memory-layer facet tag --project /path/to/project --target-type event --target-id <id> --dimension workflow --value release --actor <actor> --apply
claude-memory-layer action list --project /path/to/project
claude-memory-layer frontier --project /path/to/project --limit 20
claude-memory-layer checkpoint list --project /path/to/project
claude-memory-layer retention audit --project /path/to/project

# Dashboard
claude-memory-layer dashboard --no-open
claude-memory-layer dashboard --bind localhost --port 37777 --password "<local-password>" --no-open

# External read-only market/company context
claude-memory-layer market-context --company 삼성전자 --dart-corp-code 00126380 --symbol 005930.KS --json
```

MongoDB 동기화는 선택 기능입니다. 여러 서버에서 같은 프로젝트를 개발할 때, 각 서버의 로컬 SQLite 이벤트를 하나의 MongoDB로 모아 push/pull할 수 있습니다. Pull된 이벤트를 바로 semantic search/context-pack에서 쓰고 싶다면 `--process-after-sync`를 함께 켜서 새 이벤트가 내려온 뒤 pending embedding/vector outbox를 처리하세요.

```bash
export CLAUDE_MEMORY_MONGO_URI="mongodb://USER:***@HOST:PORT/"
export CLAUDE_MEMORY_MONGO_DB="claude_memory_layer"
export CLAUDE_MEMORY_MONGO_PROJECT="my-project"
claude-memory-layer mongo-sync
claude-memory-layer mongo-sync --watch --interval 30000
claude-memory-layer mongo-sync --watch --interval 30000 --process-after-sync --process-interval 120000
```

`--process-after-sync`는 pull된 이벤트가 있을 때만 실행되며, `--process-interval` 동안 debounce되어 매 sync tick마다 불필요하게 임베딩을 재처리하지 않습니다. 내부적으로 project-scoped `vector-worker.lock`을 사용하므로 별도 `process` worker가 이미 실행 중이면 skip합니다.

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
   "SQLite/WAL을 사용하여 이벤트 소싱 패턴을..."
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
claude-memory-layer endless enable

# 상태 확인
claude-memory-layer endless status

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

> 현재 상태: MCP server implementation은 `src/extensions/mcp/`로 이동되어 있고,
> `src/mcp/*`는 compatibility shim입니다. package bin으로
> `claude-memory-layer-mcp`가 제공됩니다.

Claude Desktop 설정은 CLI로 자동 등록할 수 있습니다:

```bash
claude-memory-layer mcp install
# Config: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
```

이 명령은 Claude Desktop config의 기존 값을 보존하면서 다음 MCP server entry를 추가/갱신합니다:

```json
{
  "mcpServers": {
    "claude-memory-layer": {
      "command": "claude-memory-layer-mcp",
      "args": []
    }
  }
}
```

옵션:

```bash
claude-memory-layer mcp install --dry-run
claude-memory-layer mcp install --config-path /path/to/claude_desktop_config.json
claude-memory-layer mcp install --server-name claude-memory-layer --command claude-memory-layer-mcp
```

설정 후 Claude Desktop을 재시작하면 MCP 서버가 로드됩니다. Codex/Hermes처럼 MCP client가 있는 다른 agent에는 로컬 checkout의 built server를 직접 등록할 수 있습니다:

```bash
# Codex
codex mcp add claude-memory-layer -- node /path/to/claude-memory-layer/dist/mcp/index.js

# Hermes
hermes mcp add claude-memory-layer --command node --args /path/to/claude-memory-layer/dist/mcp/index.js
```

로컬 checkout에서 서버만 바로 테스트하려면 `npm run build` 후 다음처럼 직접 실행할 수도 있습니다:

```bash
node dist/mcp/index.js
```

### 제공되는 MCP 도구

| 범주 | 도구 | 설명 |
|------|------|------|
| Search | `mem-search` | 프로젝트/세션 스코프 메모리 검색 |
| Search | `mem-timeline` / `mem-details` | 검색 결과 주변 타임라인과 상세 내용 조회 |
| Search | `mem-stats` | aggregate memory/vector/outbox 통계 |
| Context | `mem-context-pack` | 작업 시작용 relevant memory + recent timeline + follow-up refs; privacy-safe query trace를 기록해 dashboard/replay usage 분석에 포함 |
| Context | `mem-import-latest` | 최신 Claude/Codex/Hermes 세션을 bounded import 후 context-pack freshness 확보 |
| Context | `mem-project-timeline` | 최근 프로젝트 메모리를 session/source/count/safe-preview로 요약 |
| Context | `mem-source-ref` | `mem:`/`event:` ref를 redacted preview와 safe metadata로 해석; `includeNeighbors` + `neighborWindow`로 같은 세션의 전후 이벤트를 bounded/privacy-safe preview로 확장 |
| Operations | `mem-facet-query` / `mem-facet-tag` | project-scoped facet 조회/태깅 |
| Operations | `mem-action-list` / `mem-action-update` | 다음 작업/action 상태 조회·갱신 |
| Operations | `mem-frontier` | blocked/next action frontier와 safe resume hints |
| Operations | `mem-checkpoint-create` / `mem-checkpoint-list` | resumable action/session checkpoint 관리 |
| Operations | `mem-retention-audit` | dry-run retention governance audit |
| Operations | `mem-graph-query` | bounded graph expansion/query diagnostics |
| Operations | `mem-lesson-list` | procedural lesson/skill 후보 조회 |
| Perspective | `mem-actor-list` | project-scoped actor 목록 |
| Perspective | `mem-actor-card-get` / `mem-actor-card-upsert` | observer→observed actor card 조회/갱신 |
| Perspective | `mem-perspective-query` | observer→observed perspective observation 검색 |
| Perspective | `mem-perspective-context` | actor card + perspective observations context bundle |
| Perspective | `mem-perspective-observation-create` / `mem-perspective-observation-delete` | audited observation 생성/soft-delete |
| External | `external-market-context` | DART/FRED/Finnhub read-only MarketContextSnapshot |

대부분의 project-scoped 도구는 `projectPath`를 지원하거나 요구합니다. mutating 도구는 audit용 `actor`와 evidence/source refs를 요구하고, raw transcript/path/secret 출력은 피합니다.

예시 workflow:

```text
1. 새 작업 시작: mem-context-pack(projectPath, query)
2. 최근 흐름 확인: mem-project-timeline(projectPath)
3. 근거가 더 필요할 때: mem-source-ref(projectPath, ids=["mem:abc123"], includeNeighbors=true, neighborWindow=1)
```

이 workflow는 Hermes/Codex/Claude Code가 같은 project-scoped memory backend를 공유할 때 특히 유용합니다. `mem-source-ref`는 raw transcript를 그대로 덤프하지 않고 allowlisted metadata와 privacy-filtered preview만 반환합니다.

## Web Viewer

브라우저에서 메모리 대시보드를 확인할 수 있습니다:

```bash
# 웹 서버 시작
claude-memory-layer dashboard

# 브라우저에서 접속
# http://localhost:37777
```

### 주요 기능
- 실시간 이벤트 스트림과 세션/프로젝트별 탐색
- 벡터/키워드 검색 인터페이스와 저장소 통계
- Retrieval Trace: 질의 → 후보/채택 수 → 최종 context IDs, score breakdown(semantic/lexical/recency), lane debug
- Vector Health: embedding/vector queue pending/processing/failed/stuck, vector count, recovery action 결과
- Perspective Memory: actor/session membership, observer→observed graph, actor-card counts, observation/contradiction/source-evidence aggregate
- Dashboard auth hardening: 기본 `localhost` bind, 명시적 `0.0.0.0`, 선택적 password gate
- API errors/output은 aggregate 중심으로 렌더링하고 raw path, item id, error payload, memory content 노출을 피함

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

### Codex 세션 임포트

Codex CLI 기록(`~/.codex/sessions`)은 기본적으로 read-only validate/replay로 먼저 확인하고, 명시적 import 명령으로만 메모리에 저장합니다:

```bash
# 읽기 전용 검증/리포트
npx claude-memory-layer codex validate --project /path/to/project --format markdown

# 현재 프로젝트 Codex 세션을 프로젝트별 메모리로 import
cd /path/to/project
npx claude-memory-layer codex import

# 특정 세션만 import
npx claude-memory-layer codex import --project /path/to/project --session /path/to/session.jsonl

# 모든 Codex 세션 import (전역 저장소 사용; 필요할 때만)
npx claude-memory-layer codex import --all --verbose
```

옵션: `--sessions-dir`, `--limit`, `--force`, `--no-process-embeddings`.

### Hermes 세션 임포트

Hermes Agent 기록(`~/.hermes/state.db`)도 원본 DB를 read-only validate/replay로 먼저 확인하고, 명시적 import 명령으로만 프로젝트별 메모리에 저장합니다. 기본 전략은 live sync가 아니라 **SessionDB → CML explicit derived import**입니다:

```bash
# 읽기 전용 검증/리포트
npx claude-memory-layer hermes validate --project /path/to/project --format markdown

# 현재 프로젝트 Hermes 세션을 프로젝트별 메모리로 import
cd /path/to/project
npx claude-memory-layer hermes import

# 특정 Hermes session id만 import
npx claude-memory-layer hermes import --project /path/to/project --session 20260505_010203_abcd1234

# 모든 Hermes 세션 import (전역 저장소 사용; 필요할 때만)
npx claude-memory-layer hermes import --all --verbose
```

옵션: `--state-db`, `--limit`, `--force`, `--no-process-embeddings`.

Hermes import는 user/assistant turn만 저장하고 tool/system 메시지는 건너뜁니다. 검증 리포트에는 aggregate count만 포함되며 transcript 본문은 포함하지 않습니다.

### 중복 처리

임포트는 콘텐츠 해시 기반으로 중복을 자동 감지합니다. 여러 번 실행해도 같은 내용이 중복 저장되지 않습니다.

## 동작 원리

### 1. 메모리 저장

```
사용자 프롬프트 입력
        ↓
    EventStore에 저장 (SQLite/WAL, append-only)
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
┌──────────────────────────────────────────────────────────────────────┐
│ Agent surfaces                                                       │
│ Claude Code Hooks │ CLI │ Dashboard │ MCP Clients │ Codex/Hermes import │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Memory Service / Runtime                                             │
│ Retrieval Orchestrator │ Disclosure │ Operations │ Perspective Memory │
│ Evidence/Privacy filters │ Governance audit │ Context-pack assembler │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
┌──────────────────┐   ┌──────────────────┐   ┌───────────────────────┐
│ SQLite EventStore│   │ Operations tables│   │ External read-only ctx │
│ events/sessions  │   │ facets/actions/  │   │ DART/FRED/Finnhub     │
│ actor/perspective│   │ checkpoints/...  │   │                       │
└─────────┬────────┘   └──────────────────┘   └───────────────────────┘
          │ same transaction
          ▼
┌──────────────────┐      worker lock/recovery      ┌──────────────────┐
│ Vector Outbox V2 │ ─────────────────────────────▶ │ LanceDB vectors  │
│ itemKind/id/ver  │   versioned delete+add upsert  │ per item/version │
└──────────────────┘                                └──────────────────┘
```

핵심 원칙은 SQLite가 canonical source of truth이고, LanceDB는 재생성 가능한 derived accelerator라는 점입니다. 모든 vector write는 outbox를 통해 idempotent하게 처리하며, MCP/dashboard/CLI 출력은 가능한 aggregate 또는 redacted preview만 제공합니다.

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

1. **Single Source of Truth**: SQLite/WAL EventStore가 유일한 진실의 원천
2. **Append-Only**: 이벤트는 수정/삭제 없이 추가만
3. **Idempotency**: dedupe_key로 중복 이벤트 감지
4. **Evidence Alignment**: 주장이 실제 소스에 기반했는지 검증
5. **Entity-Based Tasks**: canonical_key로 일관된 엔티티 식별
6. **Vector Store Consistency**: SQLite outbox → LanceDB 단방향 흐름
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

- **SQLite / WAL**: 이벤트 저장소 (canonical append/read model)
- **LanceDB**: 벡터 저장소 (derived acceleration index)
- **@huggingface/transformers**: 로컬 임베딩 생성 (lazy import; Embedder는 `src/extensions/vector/`)
- **Zod**: 런타임 타입 검증
- **Commander**: CLI 인터페이스
- **TypeScript**: 타입 안전한 코드
- **Node.js + Hono**: HTTP 서버 / Web Viewer
- **Hono**: 경량 라우터
- **MCP SDK**: Claude Desktop 통합 (`claude-memory-layer-mcp` stdio server)

## Specification Documents

상세 설계 문서는 `specs/` 디렉토리에서 확인할 수 있습니다:

| 문서 | 설명 |
|------|------|
| [agentmemory-inspired-memory-operations](specs/agentmemory-inspired-memory-operations/spec.md) | facets/actions/frontier/checkpoints/retention/lessons 운영형 메모리 |
| [honcho-inspired-peer-context-memory](specs/honcho-inspired-peer-context-memory/spec.md) | actor card / perspective observation / multi-agent 관점 메모리 |
| [vector-outbox-v2](specs/vector-outbox-v2/spec.md) | Transactional Outbox, versioned vector upsert, worker recovery |
| [mcp-desktop-integration](specs/mcp-desktop-integration/spec.md) | MCP 서버 통합 |
| [progressive-disclosure](specs/progressive-disclosure/spec.md) | 토큰 효율화 검색 |
| [citations-system](specs/citations-system/spec.md) | 메모리 인용 시스템 |
| [private-tags](specs/private-tags/spec.md) | 프라이버시 태그 |
| [entity-edge-model](specs/entity-edge-model/spec.md) | 3-Layer 데이터 모델 |
| [task-entity-system](specs/task-entity-system/spec.md) | Task Entity 관리 |
| [evidence-aligner-v2](specs/evidence-aligner-v2/spec.md) | 증거 정렬 시스템 |
| [post-tool-use-hook](specs/post-tool-use-hook/spec.md) | 도구 사용 기록 |
| [endless-mode](specs/endless-mode/spec.md) | 연속 세션 모드 |
| [web-viewer-ui](specs/web-viewer-ui/spec.md) | 웹 대시보드 |

## Roadmap / Current State

### Completed / shipped

- [x] SQLite/WAL Event Store + project registry
- [x] LanceDB vector store + local embedding backend
- [x] Claude Code hooks, CLI, dashboard
- [x] History import for Claude Code, Codex, Hermes
- [x] Progressive disclosure, citations, source refs, retrieval traces
- [x] MCP server with project-aware context/search/stat tools
- [x] Memory Operations layer: facets/actions/frontier/checkpoints/retention/graph/lessons
- [x] Perspective Memory P0/P1: actors, actor cards, observations, context lanes, dashboard aggregate stats
- [x] Vector Outbox V2: transactional enqueue, versioned upsert, worker lock, stuck recovery, vector-status/dashboard health
- [x] Dashboard hardening: localhost default bind, optional password auth, safe error rendering
- [x] External Market Context: DART/FRED/Finnhub read-only snapshot + MCP tool

### Active / experimental

- [ ] Entity-Edge Model productization beyond diagnostic graph expansion
- [ ] Task Entity System broader productization and UX
- [ ] Mongo sync operational hardening for multi-server teams
- [ ] Endless/shared memory UX and default safety policy
- [ ] Retrieval/replay benchmarks for ranking-changing features before default enablement
- [ ] Perspective Memory LLM deriver/specialists broader production rollout (currently opt-in/guarded)

## External Market Context (DART/FRED/Finnhub)

`claude-memory-layer market-context` fetches read-only external company and market data from environment-configured providers and returns a structured `MarketContextSnapshot` plus a Markdown analysis report.

Example:

```bash
export DART_API_KEY=...      # env-only; never commit real keys
export FRED_API_KEY=...
export FINNHUB_API_KEY=...
claude-memory-layer market-context \
  --company 삼성전자 \
  --dart-corp-code 00126380 \
  --symbol 005930.KS \
  --providers dart,fred,finnhub \
  --fred-series FEDFUNDS,CPIAUCSL \
  --json
```

Security and behavior:

- API keys are read only from `DART_API_KEY`, `FRED_API_KEY`, and `FINNHUB_API_KEY`.
- `.env*` files are ignored; `.env.example` is placeholder-only.
- Missing provider keys produce skipped-provider statuses rather than hard failures.
- Provider requests use bounded timeouts; large FRED series lists are capped to the first 10 unique series.
- Empty Finnhub profile responses are treated as skipped-provider/no-data results, not profile evidence.
- Provider errors and rendered reports redact credential-bearing query params such as `crtfc_key`, `api_key`, and `token`.
- The MCP `external-market-context` tool is read-only and does not initialize or mutate memory storage.
- `--no-snapshot` / MCP `includeSnapshot: false` disables both `analysis.marketSnapshot` and the DART company snapshot.

`MarketContextSnapshot` includes:

- `schemaVersion: market-context-snapshot.v1`
- `subject`: company, DART corpCode, ticker symbol
- `coverage`: DART/FRED/Finnhub provider status and counts
- `bullCases`, `bearCases`, `risks`, `catalysts`: deterministic evidence-backed insights
- `watchlist` and `followUpQuestions`

The Markdown report includes a `### MarketContextSnapshot` section with **Bull case**, **Bear case**, **Risks**, and **Catalysts**. DART analysis uses all fetched filings; only the rendered filing list is truncated. If `dartCorpCode` is omitted, company-name fallback is marked low-confidence, so exact DART corp codes are recommended for customer-facing analysis.

## License

MIT
