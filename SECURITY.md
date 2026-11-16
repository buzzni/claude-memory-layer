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

### 대시보드

- **기본 bind는 localhost**입니다. `dashboard` 명령과 `DASHBOARD_HOST`는 `localhost`, `127.0.0.1`, `0.0.0.0`만 받고, 지정하지 않으면 `127.0.0.1`에 bind합니다.
- **Host 헤더를 허용 목록으로 검사**합니다(DNS rebinding 방어). localhost에만 bind해도, 공격자 도메인을 127.0.0.1로 다시 해석시키면 브라우저는 그 도메인의 페이지를 대시보드와 같은 출처로 취급합니다. 이때도 브라우저는 `Host`에 공격자 도메인을 보내므로, 서버는 `Host`가 허용 목록에 없는 요청을 모든 경로(`/health`, `/api/auth/*`, 정적 파일 포함)에서 본문 없이 403으로 거절합니다. 이 검사는 비밀번호 검사보다 먼저 돕니다.
  - 기본 허용: `localhost`, `127.0.0.1`, `[::1]` + 실제 포트(예: `localhost:37777`). 대소문자와 끝의 점 하나(`localhost.`)는 무시합니다. 포트가 없는 `Host`는 80번 포트로 봅니다. `Host`가 없는 요청도 거절합니다.
  - 그 밖의 이름이나 주소로 접속하려면 `DASHBOARD_ALLOWED_HOSTS`(쉼표 구분)에 적습니다. `hostname`은 모든 포트, `hostname:port`는 그 포트만 허용합니다. 예: `DASHBOARD_ALLOWED_HOSTS=192.168.0.10:37777,memory.example.com`. 출처 URL(`http://…`) 형식은 받지 않습니다(그런 항목은 무시됩니다).
- **비밀번호는 선택**입니다. `--password` 또는 `DASHBOARD_PASSWORD`(`CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD`)로 켭니다. 켜면 `/health`, `/api/auth/*`를 뺀 모든 경로가 로그인을 요구합니다. 세션 쿠키는 HMAC-SHA256 서명, `HttpOnly`, `SameSite=Lax`이고 기본 30일 뒤 만료됩니다. HTTPS(또는 `X-Forwarded-Proto: https`)로 들어온 요청이면 `Secure`도 붙습니다.
- **비밀번호가 없으면 API에 인증이 없습니다.** 포트에 닿을 수 있고 허용된 `Host`를 보내는 모든 것이 저장된 메모리를 읽을 수 있습니다. 로컬의 다른 프로세스나 `curl`은 `Host`를 마음대로 정할 수 있으므로, Host 검사는 브라우저를 통한 공격만 막습니다. `0.0.0.0`으로 bind할 때는 반드시 비밀번호를 설정하세요(설정하지 않으면 CLI가 경고합니다). `0.0.0.0` bind에서도 기본으로는 loopback 이름만 허용하므로, LAN 주소나 호스트 이름으로 접속하려면 `DASHBOARD_ALLOWED_HOSTS`도 설정해야 합니다(설정하지 않으면 서버가 시작할 때 경고합니다).
- **CORS는 기본적으로 same-origin만** 허용합니다. CORS 헤더를 내보내지 않으므로 브라우저는 다른 출처 페이지가 API 응답을 읽지 못하게 막습니다. `DASHBOARD_ALLOWED_ORIGINS`(쉼표 구분)에 적은 출처에만 CORS를 엽니다.
- **상태를 바꾸는 API 요청은 Origin을 검사**합니다. `/api/*`에 대한 GET·HEAD·OPTIONS 외 요청에 `Origin` 헤더가 있으면, 그 출처가 위 Host 허용 목록의 호스트를 가리키는 `http`/`https` 출처이거나 `DASHBOARD_ALLOWED_ORIGINS`에 있어야 하고, 아니면 403으로 거절합니다. 요청의 `Host` 헤더와는 비교하지 않습니다(rebinding된 페이지는 `Host`와 `Origin`을 함께 공격자 도메인으로 보냅니다). `Origin`이 없는 요청(CLI, curl)은 로컬 사용을 위해 통과시킵니다.

### 저장 전 마스킹

Claude Code 훅은 저장하기 전에 아래 마스킹을 적용합니다. 어디에 무엇이 적용되는지는 필드마다 다릅니다.

| 저장 대상 | `<private>` 태그 | 자격 증명 패턴 |
| --- | --- | --- |
| 사용자 프롬프트 (세션 기록 importer 포함) | ✅ | ✅ |
| 어시스턴트 응답 | ✅ | ✅ |
| 도구 출력 (PostToolUse) | ✅ | ✅ |
| 도구 입력 (PostToolUse) | ❌ | ✅ |
| 도구 stderr (PostToolUse) | ❌ | ❌ 원본 그대로 저장 |

- **`<private>` 태그**: `<private>…</private>`로 감싼 부분은 `[PRIVATE]`로 바뀐 채 저장됩니다. 위 표에서 ✅인 필드에만 적용되고, 코드 블록이나 인라인 코드 안에 쓴 `<private>` 태그는 마스킹 지시로 처리하지 않습니다.
- **자격 증명 마스킹**: 다음 패턴을 `[REDACTED]`로 바꿉니다. `password`·`secret`·`token`·`api_key` 형태의 할당, `--password` 같은 CLI 옵션 값, 사용자 정보가 들어간 URI(`scheme://user:pass@host`), Bearer 토큰, PEM 개인 키, AWS·GitHub·GitLab·Slack·Hugging Face·OpenAI·Anthropic 토큰 접두사. 도구 입력은 키 이름에 `password`·`secret`·`key`·`token`·`auth`·`credential`이 들어간 문자열 값을 통째로 가립니다.
- **경로 마스킹**: retention·governance 감사 결과는 절대 경로를 마스킹합니다. Hermes 세션 원본 경로는 공개 source ref에서 가려집니다.

이 필터는 패턴 기반입니다. 패턴에 맞지 않는 비밀값은 그대로 저장될 수 있습니다. `<private>`는 프롬프트와 응답에 쓴 내용을 가릴 때 쓰세요. 도구에 넘기는 입력이나 도구가 stderr로 내보내는 값은 이 태그로 가려지지 않습니다.

### Mongo sync

Mongo sync는 기본으로 꺼져 있습니다. 훅에서는 실행되지 않고, `mongo-sync` 명령을 직접 실행할 때(1회 또는 `--watch`로 계속)만 동작합니다.

- 연결 정보는 `--mongo-uri`/`--mongo-db` 옵션이나 `CLAUDE_MEMORY_MONGO_URI`/`CLAUDE_MEMORY_MONGO_DB` 환경 변수로 받습니다. 연결 오류 메시지에서는 URI의 비밀값을 가립니다.
- push는 로컬에 저장된 이벤트를 저장된 그대로, 이 머신의 hostname·인스턴스 ID와 함께 MongoDB로 보냅니다. 따라서 위 "저장 전 마스킹" 표에서 마스킹되지 않는 필드(도구 입력의 `<private>`, 도구 stderr)도 그대로 전송됩니다.
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
