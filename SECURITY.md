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
- **비밀번호는 선택**입니다. `--password` 또는 `DASHBOARD_PASSWORD`(`CLAUDE_MEMORY_LAYER_DASHBOARD_PASSWORD`)로 켭니다. 켜면 `/health`, `/api/auth/*`를 뺀 모든 경로가 로그인을 요구합니다. 세션 쿠키는 HMAC-SHA256 서명, `HttpOnly`, `SameSite=Lax`이고 기본 30일 뒤 만료됩니다. HTTPS(또는 `X-Forwarded-Proto: https`)로 들어온 요청이면 `Secure`도 붙습니다.
- **비밀번호가 없으면 API에 인증이 없습니다.** 포트에 닿을 수 있는 모든 것이 저장된 메모리를 읽을 수 있습니다. `0.0.0.0`으로 bind할 때는 반드시 비밀번호를 설정하세요(설정하지 않으면 CLI가 경고합니다).
- **CORS는 기본적으로 same-origin만** 허용합니다. CORS 헤더를 내보내지 않으므로 브라우저는 다른 출처 페이지가 API 응답을 읽지 못하게 막습니다. `DASHBOARD_ALLOWED_ORIGINS`(쉼표 구분)에 적은 출처에만 CORS를 엽니다.
- **상태를 바꾸는 API 요청은 Origin을 검사**합니다. `/api/*`에 대한 GET·HEAD·OPTIONS 외 요청에 `Origin` 헤더가 있으면, 서버 자신의 출처나 허용 목록과 일치해야 하고 아니면 403으로 거절합니다. `Origin`이 없는 요청(CLI, curl)은 로컬 사용을 위해 통과시킵니다.

### 저장 전 마스킹

Claude Code 훅은 사용자 프롬프트, 도구 입력·출력, 어시스턴트 응답을 **저장하기 전에** 프라이버시 필터에 통과시킵니다. 세션 기록 importer도 프롬프트에 같은 필터 설정을 씁니다.

- **`<private>` 태그**: `<private>…</private>`로 감싼 부분은 `[PRIVATE]`로 바뀐 채 저장됩니다. 단, 코드 블록이나 인라인 코드 안에 쓴 `<private>` 태그는 마스킹 지시로 처리하지 않습니다.
- **자격 증명 마스킹**: 다음 패턴을 `[REDACTED]`로 바꿉니다. `password`·`secret`·`token`·`api_key` 형태의 할당, `--password` 같은 CLI 옵션 값, 사용자 정보가 들어간 URI(`scheme://user:pass@host`), Bearer 토큰, PEM 개인 키, AWS·GitHub·GitLab·Slack·Hugging Face·OpenAI·Anthropic 토큰 접두사. 도구 입력 중 키 이름에 `password`·`secret`·`key`·`token`·`auth`·`credential`이 들어간 문자열 값도 통째로 가립니다.
- **경로 마스킹**: retention·governance 감사 결과는 절대 경로를 마스킹합니다. Hermes 세션 원본 경로는 공개 source ref에서 가려집니다.

이 필터는 패턴 기반입니다. 패턴에 맞지 않는 비밀값은 그대로 저장될 수 있으니, 민감한 내용은 `<private>`로 감싸세요.

### Mongo sync

Mongo sync는 기본으로 꺼져 있습니다. `mongo-sync` 명령을 직접 실행하거나, 프로젝트 설정으로 SessionEnd 자동 sync를 켰을 때만 동작합니다.

- 설정을 저장하면 연결 URI(자격 증명 포함 가능)가 프로젝트 저장소 디렉터리의 설정 파일에 **평문으로** 들어갑니다. 파일은 권한 `0600`으로 씁니다. 연결 오류 메시지에서는 URI의 비밀값을 가립니다.
- push는 로컬 이벤트(저장 전 마스킹을 거친 내용)와 이 머신의 hostname, 인스턴스 ID를 MongoDB로 보냅니다.
- pull은 다른 머신이 push한 이벤트를 로컬 저장소에 넣습니다. 이 이벤트는 이후 회상 결과로 프롬프트에 주입될 수 있습니다. **그 MongoDB 데이터베이스에 쓰기 권한이 있는 모든 주체를 신뢰 경계 안쪽으로 보세요.** 직접 관리하고 쓰기 권한을 통제하는 데이터베이스만 연결하세요.

## 기기 밖으로 나가는 데이터

이 패키지에는 사용 통계나 오류를 외부로 보내는 텔레메트리가 없습니다. 코드의 "telemetry"는 로컬 저장소에만 기록되는 회상·리소스 지표입니다.

데이터가 기기 밖으로 나가는 경우는 다음과 같습니다.

| 경로 | 언제 | 보내는 것 | 끄는 방법 |
| --- | --- | --- | --- |
| LLM 세션 요약 | **기본 켜짐** | 세션의 프롬프트·응답 일부를 로컬 `claude` CLI(또는 `codex`)에 넘깁니다. 그 CLI가 사용자 계정으로 해당 provider에 보냅니다. | `CLAUDE_MEMORY_SUMMARY_MODE=rule` 또는 `off` |
| LLM lesson 추출 | **기본 켜짐**, `mem-lesson-candidates` MCP 도구를 호출할 때 | 후보 세션의 내용을 같은 방식으로 `claude`/`codex` CLI에 넘깁니다. | `CLAUDE_MEMORY_LESSON_MODE=off` |
| 대시보드 채팅 | 대시보드에서 채팅을 쓸 때 | 질문과 회상한 메모리를 로컬 `claude` CLI에 넘깁니다. | 채팅을 쓰지 않으면 나가지 않습니다 |
| Mongo sync | 직접 실행하거나 켰을 때 | 위 "Mongo sync" 참고 | 실행하지 않거나 자동 sync를 끕니다 |
| 질의 의도 재작성 | `MEMORY_INTENT_REWRITE_ENABLED=1`이고 API URL을 설정했을 때 | 회상 질의 텍스트를 설정한 URL로 보냅니다. | 기본 꺼짐 |
| `external-market-context` MCP 도구 | `experimental`/`all` 프로필에서 도구를 호출하고 해당 API 키가 있을 때 | 회사명·종목 코드를 DART·FRED·Finnhub API로 보냅니다. | API 키를 설정하지 않으면 건너뜁니다 |
| 임베딩 모델·백엔드 다운로드 | 설치(postinstall)와 첫 임베딩 때 | 사용자 데이터는 보내지 않습니다. npm 레지스트리와 Hugging Face Hub에서 패키지·모델을 내려받기만 합니다. 임베딩 계산은 로컬에서 합니다. | `CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL=1`로 설치 시 다운로드를 건너뜁니다 |
