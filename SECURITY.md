# 보안 정책

## 취약점 제보

취약점은 공개 이슈로 올리지 말고 GitHub의 비공개 취약점 제보(private vulnerability reporting)로 알려 주세요.

1. 저장소의 **Security** 탭 → **Report a vulnerability**를 누릅니다.
2. 영향받는 버전, 재현 절차, 예상되는 영향을 적습니다. 실제 메모리 데이터나 자격 증명은 첨부하지 마세요.

제보는 메인테이너만 볼 수 있고, 수정이 배포되기 전까지 공개되지 않습니다.

## 지원 버전

보안 수정은 npm에 배포된 최신 minor 계열에만 들어갑니다.

| 버전 | 지원 |
| --- | --- |
| 2.5.x | ✅ |
| 2.5 미만 | ❌ |

## 위협 모델

Claude Memory Layer는 한 사용자의 머신에서 돌아가는 로컬 도구입니다. 훅·CLI·MCP 서버·대시보드가 같은 로컬 저장소(기본 `~/.claude-code/memory`)를 읽고 씁니다. 그 머신에서 이 사용자 권한으로 실행되는 다른 프로세스는 신뢰 경계 **안쪽**으로 봅니다. 저장소 파일 자체는 암호화하지 않습니다.

사람 확인 없이 도는 작업(훅, daemon, maintenance)이 지우거나 바꾸는 것과, 감사 기록 없이 기억을 지우는 명령은 [OPERATIONS.md](docs/OPERATIONS.md#what-unattended-work-changes-and-what-it-does-not)에 정리했습니다.

### 대시보드

- **기본 bind는 localhost**입니다. `dashboard` 명령과 `DASHBOARD_HOST`는 `localhost`, `127.0.0.1`, `0.0.0.0`만 받고, 지정하지 않으면 `127.0.0.1`에 bind합니다.
- **Host 헤더를 허용 목록으로 검사**합니다(DNS rebinding 방어). localhost에만 bind해도, 공격자 도메인을 127.0.0.1로 다시 해석시키면 브라우저는 그 도메인의 페이지를 대시보드와 같은 출처로 취급합니다. 이때도 브라우저는 `Host`에 공격자 도메인을 보내므로, 서버는 `Host`가 허용 목록에 없는 요청을 모든 경로(`/health`, `/api/auth/*`, 정적 파일 포함)에서 본문 없이 403으로 거절합니다. 이 검사는 비밀번호 검사보다 먼저 돕니다. 문법이 잘못된 `Host`(공백·`@` 포함 등)나 HTTP/1.1 요청의 `Host` 누락은 그보다 앞서 Node HTTP 서버나 어댑터가 400으로 거절하므로, 403은 허용 목록 검사까지 도달한 요청에 해당합니다.
  - 기본 허용: `localhost`, `127.0.0.1`, `[::1]` + 실제 포트(예: `localhost:37777`). 대소문자와 끝의 점 하나(`localhost.`)는 무시합니다. 포트가 없는 `Host`는 80번 포트로 봅니다. `Host`가 없는 요청도 거절합니다.
  - 그 밖의 이름이나 주소로 접속하려면 `DASHBOARD_ALLOWED_HOSTS`(쉼표 구분)에 적습니다. `hostname`은 모든 포트, `hostname:port`는 그 포트만 허용합니다. 예: `DASHBOARD_ALLOWED_HOSTS=192.168.0.10:37777,memory.example.com`. 출처 URL(`http://…`) 형식은 받지 않습니다(그런 항목은 무시됩니다).
- **비밀번호는 선택**입니다. `--password` 또는 `DASHBOARD_PASSWORD`(`CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD`)로 켭니다. 켜면 `/health`, `/api/auth/*`를 뺀 모든 경로가 로그인을 요구합니다. 세션 쿠키는 HMAC-SHA256 서명, `HttpOnly`, `SameSite=Lax`이고 기본 30일 뒤 만료됩니다. HTTPS(또는 `X-Forwarded-Proto: https`)로 들어온 요청이면 `Secure`도 붙습니다.
- **비밀번호가 없으면 API에 인증이 없습니다.** 포트에 닿을 수 있고 허용된 `Host`를 보내는 모든 것이 저장된 메모리를 읽을 수 있습니다. 로컬의 다른 프로세스나 `curl`은 `Host`를 마음대로 정할 수 있으므로, Host 검사는 브라우저를 통한 공격만 막습니다. `0.0.0.0`으로 bind할 때는 반드시 비밀번호를 설정하세요(설정하지 않으면 CLI가 경고합니다). `0.0.0.0` bind에서도 기본으로는 loopback 이름만 허용하므로, LAN 주소나 호스트 이름으로 접속하려면 `DASHBOARD_ALLOWED_HOSTS`도 설정해야 합니다(설정하지 않으면 서버가 시작할 때 경고합니다).
- **CORS는 기본적으로 same-origin만** 허용합니다. CORS 헤더를 내보내지 않으므로 브라우저는 다른 출처 페이지가 API 응답을 읽지 못하게 막습니다. `DASHBOARD_ALLOWED_ORIGINS`(쉼표 구분)에 적은 출처에만 CORS를 엽니다.
- **상태를 바꾸는 API 요청은 Origin을 검사**합니다. `/api/*`에 대한 GET·HEAD·OPTIONS 외 요청에 `Origin` 헤더가 있으면, 그 출처가 위 Host 허용 목록의 호스트를 가리키는 `http`/`https` 출처이거나 `DASHBOARD_ALLOWED_ORIGINS`에 있어야 하고, 아니면 403으로 거절합니다. 요청의 `Host` 헤더와는 비교하지 않습니다(rebinding된 페이지는 `Host`와 `Origin`을 함께 공격자 도메인으로 보냅니다). `Origin`이 없는 요청(CLI, curl)은 로컬 사용을 위해 통과시킵니다.

### 회상된 기억의 출처

회상되는 기억에는 도구 출력(파일, 웹 페이지, 명령 결과)처럼 대화 밖에서 들어온 텍스트가 섞여 있습니다. 그런 텍스트에 심어 둔 지시문은 나중에 기억으로 주입되어 에이전트를 움직일 수 있습니다(메모리 오염, OWASP Agentic ASI06). 렌더 시점 sanitizer는 보이지 않는 문자와 래퍼 태그를 지우지만, 평범한 문장으로 쓴 지시는 막지 못합니다. 그래서 회상 출력은 기억의 출처를 함께 보여 줍니다. 도구 출력, 다른 머신에서 온 기억(Mongo sync로 pull한 행), 출처를 알 수 없는 가져오기, 유형을 알 수 없는 기억에는 `low-trust` 라벨이 붙습니다([HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md#source-trust-labels)). `operations.json`의 `sourceTrust.excludeUntrustedFromAutoInjection`을 켜면 도구 출력과 출처 미상 기억은 자동 주입에서 빠집니다. MCP나 CLI로 직접 조회할 때는 결과에서 빠지지 않고 라벨만 붙습니다.

이 머신의 호스트 세션 기록을 사용자가 설정한 경로에서 읽어 들인 것(`claude-memory-layer import`, Codex SessionEnd 훅, Hermes import)은 실시간 캡처와 같은 신뢰로 다룹니다. 그 기록은 이 사용자의 호스트가 이 머신에 쓴 것이고, Codex는 모든 세션을 이 경로로 저장하므로 여기에 라벨을 붙이면 Codex 사용자의 모든 기억에 라벨이 붙어 의미가 없어지기 때문입니다. 대화 속 역할로 분류하므로 그 안의 도구 출력은 여전히 `tool`입니다.

분류는 저장된 행의 실제 열 값(`event_type` 등)에서 출발합니다. metadata는 그 행을 저장한 쪽(도구 출력 포함)이 쓴 값이므로 신뢰를 낮추는 근거로만 쓰고, metadata 때문에 신뢰가 올라가는 경로는 없습니다. 출처를 확인할 수 없으면(저장된 행이 없거나, 유형을 모르거나, metadata·출처 표식을 해석할 수 없으면) `unknown`입니다. 분류는 저장소가 SQLite에서 행을 읽을 때 원본 열로 한 번만 하고, 그 뒤 단계(훅, MCP, CLI)는 그 값을 전달만 합니다. semantic daemon이 보고한 유형·출처는 믿지 않고 저장된 행을 다시 읽어 씁니다. daemon의 보고는 신뢰를 낮출 때만 반영합니다. 편집 전 점검(PreToolUse)의 '실패한 도구 실행' 항목은 도구의 오류 메시지를 그대로 보여 주므로 `tool`로 라벨이 붙고, 플래그를 켜면 빠집니다.

출처는 저장된 유형과 metadata로만 판단하므로 한계가 있습니다.
- 다른 서버에서 복사해 온 세션 파일을 로컬에서 import하면 로컬 기록과 구분되지 않습니다.
- 요약과 lesson은 도구 출력의 내용을 다시 옮겨 담을 수 있지만 `derived`로 분류되어 라벨이 붙지 않습니다.
- Mongo sync pull은 이제 모든 행에 표시를 남깁니다. 그 전에 같은 프로젝트 store끼리 받은 행에는 표시가 없어 다른 머신에서 온 것으로 구분되지 않습니다.

### 저장 전 마스킹

Claude Code 훅은 저장하기 전에 아래 마스킹을 적용합니다. 어디에 무엇이 적용되는지는 필드마다 다릅니다.

| 저장 대상 | `<private>` 태그 | 자격 증명 패턴 |
| --- | --- | --- |
| 사용자 프롬프트 (세션 기록 importer 포함) | ✅ | ✅ |
| 어시스턴트 응답 | ✅ | ✅ |
| 도구 출력 (PostToolUse) | ✅ | ✅ |
| 도구 입력 (PostToolUse) | ✅ | ✅ |
| 도구 stderr (PostToolUse) | ✅ | ✅ |

- **`<private>` 태그**: `<private>…</private>`로 감싼 부분은 `[PRIVATE]`로 바뀐 채 저장됩니다. 위 표에서 ✅인 필드에만 적용되고, 코드 블록이나 인라인 코드 안에 쓴 `<private>` 태그는 마스킹 지시로 처리하지 않습니다.
- **닫히지 않은 `<private>` 태그**: 닫는 태그가 없으면 여는 태그부터 그 텍스트 끝까지를 `[PRIVATE: unclosed]` 하나로 바꿔 저장하고, privacy metadata의 `hasUnmatchedTags`를 `true`로 남깁니다. 도구 입력은 문자열 값마다 따로 거르므로 그 값의 끝까지만 가립니다. 몇 가지 규칙이 따릅니다.
  - 코드 블록·인라인 코드 밖에서 태그 이름을 문장 속에 언급만 해도 닫히지 않은 태그로 보고 그 뒤를 모두 가립니다. 태그 이름을 적을 때는 `` `<private>` ``처럼 인라인 코드로 감싸세요. 닫히지 않은 코드 펜스(```` ``` ````) 안은 코드 블록으로 보지 않습니다.
  - 여는 태그 없이 `</private>`만 있으면 어디부터 가릴지 알 수 없으므로 아무것도 가리지 않고 `hasUnmatchedTags`만 `true`가 됩니다.
  - 태그를 중첩하면 구간은 바깥 여는 태그와 짝이 맞는 `</private>`에서 끝납니다. 바깥 태그가 끝내 닫히지 않으면 안쪽 태그가 닫혀 있어도 바깥 여는 태그부터 끝까지 가립니다.
  - 이 규칙이 생기기 전에 저장된 행은 다시 가리지 않습니다. `repair redact-credentials --apply`도 예전 행과 Markdown mirror를 다시 거를 때 이 규칙은 쓰지 않고, 닫힌 태그와 자격 증명만 가립니다. 중첩된 태그는 바깥 닫는 태그까지 가리고, 바깥 태그가 닫히지 않았으면 그 뒤의 마지막 `</private>`까지 가립니다.
  - 도구 기록(tool_observation) 행은 JSON이 깨지지 않도록 `repair redact-credentials --apply`가 문자열 값마다 따로 거르고, 가린 값만 그 자리에서 바꿉니다. 행을 한 텍스트로 거를 때 가려지던 부분(한 값에서 열고 다른 값에서 닫은 태그 등)은 그대로 가립니다.
- **자격 증명 마스킹**: 다음 패턴을 `[REDACTED]`로 바꿉니다. `password`·`secret`·`token`·`api_key` 형태의 할당, `--password` 같은 CLI 옵션 값, 사용자 정보가 들어간 URI(`scheme://user:pass@host`), Bearer 토큰, PEM 개인 키, AWS·GitHub·GitLab·Slack·Hugging Face·OpenAI·Anthropic 토큰 접두사. 도구 입력은 키 이름에 `password`·`secret`·`key`·`token`·`auth`·`credential`이 들어간 문자열 값을 통째로 가립니다.
- **경로 마스킹**: retention·governance 감사 결과는 절대 경로를 마스킹합니다. Hermes 세션 원본 경로는 공개 source ref에서 가려집니다.

이 필터는 패턴 기반입니다. 패턴에 맞지 않는 비밀값은 그대로 저장될 수 있습니다. `<private>`는 프롬프트와 응답에 쓴 내용을 가릴 때 쓰세요.

### Mongo sync

Mongo sync는 기본으로 꺼져 있습니다. 훅에서는 실행되지 않고, `mongo-sync` 명령을 직접 실행할 때(1회 또는 `--watch`로 계속)만 동작합니다.

- 연결 정보는 `--mongo-uri`/`--mongo-db` 옵션이나 `CLAUDE_MEMORY_MONGO_URI`/`CLAUDE_MEMORY_MONGO_DB` 환경 변수로 받습니다. 연결 오류 메시지에서는 URI의 비밀값을 가립니다.
- push는 로컬에 저장된 이벤트를 저장된 그대로, 이 머신의 hostname·인스턴스 ID와 함께 MongoDB로 보냅니다. 따라서 위 "저장 전 마스킹" 필터가 놓친 내용과, 필터가 그 필드에 적용되기 전에 저장된 행도 그대로 전송됩니다.
- pull은 다른 머신이 push한 이벤트를 로컬 저장소에 넣습니다. 이 이벤트는 이후 회상 결과로 프롬프트에 주입될 수 있습니다. **그 MongoDB 데이터베이스에 쓰기 권한이 있는 모든 주체를 신뢰 경계 안쪽으로 보세요.** 직접 관리하고 쓰기 권한을 통제하는 데이터베이스만 연결하세요.

## 기기 밖으로 나가는 데이터

이 패키지에는 사용 통계나 오류를 외부로 보내는 텔레메트리가 없습니다. 코드의 "telemetry"는 로컬 저장소에만 기록되는 회상·리소스 지표입니다.

데이터가 기기 밖으로 나가는 경우는 다음과 같습니다.

| 경로 | 언제 | 보내는 것 | 끄는 방법 |
| --- | --- | --- | --- |
| LLM 세션 요약 | **기본 켜짐** | 세션의 프롬프트·응답 일부를 로컬 `claude` CLI(또는 `codex`)에 넘깁니다. 그 CLI가 사용자 계정으로 해당 provider에 보냅니다. | `CLAUDE_MEMORY_SUMMARY_MODE=rule` 또는 `off` |
| LLM lesson 추출 | **기본 켜짐**, `mem-lesson-candidates` MCP 도구를 호출할 때 | 후보 세션의 내용을 같은 방식으로 `claude`/`codex` CLI에 넘깁니다. | `CLAUDE_MEMORY_LESSON_MODE=off` |
| 대시보드 채팅 | 대시보드에서 채팅을 쓸 때 | 질문과 회상한 메모리를 로컬 `claude` CLI에 넘깁니다. | 채팅을 쓰지 않으면 나가지 않습니다 |
| Mongo sync | `mongo-sync` 명령을 실행했을 때 | 위 "Mongo sync" 참고 | 실행하지 않으면 나가지 않습니다 |
| 질의 의도 재작성 | `MEMORY_INTENT_REWRITE_ENABLED=1`이고 API URL을 설정했을 때 | 회상 질의 텍스트를 설정한 URL로 보냅니다. | 기본 꺼짐 |
| `external-market-context` MCP 도구 | `experimental`/`all` 프로필에서 도구를 호출하고 해당 API 키가 있을 때 | DART에는 `corp_code`(지정한 경우), FRED에는 `series_id`, Finnhub에는 `symbol`을 API 키와 함께 보냅니다. 회사명은 보내지 않고, `corp_code` 없이 받은 DART 공시 목록을 로컬에서 거를 때만 씁니다. | API 키를 설정하지 않으면 건너뜁니다 |
| 임베딩 모델·백엔드 다운로드 | 설치(postinstall)와 첫 임베딩 때 | 사용자 데이터는 보내지 않습니다. npm 레지스트리와 Hugging Face Hub에서 패키지·모델을 내려받기만 합니다. 임베딩 계산은 로컬에서 합니다. | `CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL=1`로 설치 시 다운로드를 건너뜁니다 |
