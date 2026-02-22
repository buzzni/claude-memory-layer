# Codex / AI Agent Instructions

이 저장소는 **Claude Code용 메모리 플러그인 + CLI + 로컬 대시보드 서버**입니다.
Codex(또는 다른 코딩 에이전트)가 작업할 때 아래 규칙을 우선으로 따르세요.

## Quick Commands

```bash
npm install
npm run build

# 웹 대시보드(로컬)
node dist/server/index.js
# 또는
npx claude-memory-layer dashboard
```

## Key Entry Points

- `scripts/build.ts`: esbuild 기반 빌드. `dist/` 생성 + `.claude-plugin/` 및 `src/ui` 복사
- `src/cli/index.ts`: CLI 엔트리포인트 (`bin`: `claude-memory-layer`)
- `src/server/index.ts`: 대시보드/REST API 서버 (기본 포트 `37777`)
- `src/server/api/chat.ts`: **외부 `claude` CLI**를 `spawn('claude', ...)`로 호출 (환경에 따라 미설치일 수 있음)

## Local Side-Effects (주의)

- `claude-memory-layer install` / `uninstall` 은 **사용자 머신의** `~/.claude/settings.json` 을 수정합니다.
  - 자동 실행/테스트 목적으로 임의 실행하지 말고, 사용자가 명시적으로 요청할 때만 실행하세요.
- 훅/CLI/서버는 기본적으로 `~/.claude-code/memory` 아래에 데이터를 읽고/씁니다.
  - 메모리 스토리지를 삭제/초기화하는 동작은 요청 없이는 하지 마세요.

## Common Pitfall: Self-dependency (반복 발생)

`package.json`의 `dependencies`에 **자기 자신**을 추가하면 설치가 꼬입니다.

- 금지 예: `"claude-memory-layer": "^1.0.x"`
- 진단: `npm list claude-memory-layer` 결과가 `(empty)` 여야 정상
- 복구:

```bash
rm package-lock.json && rm -rf node_modules
npm install
npm list claude-memory-layer
```

## Release / Publish Workflow

1. Self-dependency 확인: `npm list claude-memory-layer` → `(empty)`
2. 버전 업데이트: `npm version patch` 또는 `package.json` 수정
3. 빌드: `npm run build`
4. 배포: `npm publish --otp=<code>`
5. 확인: `npm view claude-memory-layer versions`

## Dev Notes

- Node.js: `>=18` (ESM 프로젝트)
- 스토리지: **SQLite(WAL) 기반**으로 훅(쓰기) + 서버(읽기) 동시 동작을 전제로 함
- 테스트/정적분석 스크립트는 존재하지만, 현재 시점에서 전부 “항상 green”을 보장하지 않을 수 있으니
  변경 전후로 실제 실행 결과를 확인하고 진행하세요.

