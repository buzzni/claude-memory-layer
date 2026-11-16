# 기여 가이드

## 개발 환경

- Node.js **20.19 이상** (`package.json`의 `engines`). CI는 Node 20과 22에서 돕니다.
- 의존성은 lock 파일 그대로 설치합니다.

  ```bash
  npm ci
  ```

  설치 중 `postinstall`이 로컬 임베딩 백엔드(`@huggingface/transformers`)를 내려받습니다. 벡터 기능을 건드리지 않는다면 `CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL=1 npm ci`로 건너뛸 수 있습니다.

## 로컬 부작용 주의

- `claude-memory-layer install` / `uninstall`은 내 머신의 `~/.claude/settings.json`을 고칩니다. 테스트 목적으로 실행하지 마세요.
- 훅·CLI·서버는 기본으로 `~/.claude-code/memory`를 읽고 씁니다. 수동 확인은 `mktemp -d`로 만든 임시 HOME에서 하세요.

## 검증 명령

PR을 올리기 전에 아래가 모두 통과해야 합니다. CI도 같은 검사를 돌립니다.

```bash
npm run verify              # typecheck + lint + test
npm run build
npm run check:architecture  # import 경계 검사
```

`npm run test:run`은 `unit` 프로젝트 다음에 부하에 민감한 `cli` 프로젝트를 직렬로 돌립니다(`vitest.config.ts`). 한 파일만 돌릴 때는 `npx vitest run <경로>`를 쓰세요.

## PR 흐름

1. `main`에서 브랜치를 만듭니다. `main`에 직접 push하지 않습니다.
2. 동작을 바꾸면 테스트를 함께 추가합니다.
3. 커밋 메시지와 PR 제목은 Conventional Commits 형식(`feat(scope): …`, `fix(scope): …`)으로 씁니다. PR 제목은 [CHANGELOG](CHANGELOG.md) 항목과 GitHub Release 노트에 그대로 쓰입니다.
4. CI(`.github/workflows/ci.yml`)가 통과해야 머지합니다. 머지는 squash로 합니다.

## 릴리스 흐름

배포는 **태그 푸시 → GitHub Actions**로만 합니다. 로컬에서 `npm publish`를 직접 실행하지 마세요. 자세한 내용은 [CLAUDE.md](CLAUDE.md)의 "npm Publish Workflow"를 참고하세요.

1. 변경 사항을 `main`에 머지합니다(CI 통과 필수).
2. `main`에서 버전을 올리고 커밋합니다. `npm version`이 `.claude-plugin/` 매니페스트 버전도 같이 맞춥니다. 커밋 전에 [CHANGELOG](CHANGELOG.md)의 `Unreleased` 항목을 새 버전 섹션으로 옮겨 같은 커밋에 넣습니다.

   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   git commit -am "chore(release): v$(node -p "require('./package.json').version")"
   git push origin main
   ```

3. 태그를 푸시하면 배포가 시작됩니다.

   ```bash
   git tag "v$(node -p "require('./package.json').version")"
   git push origin "v$(node -p "require('./package.json').version")"
   ```

4. `.github/workflows/publish-npm.yml`이 태그·버전 일치, 기배포 여부, self-dependency, `npm audit --omit=dev`, typecheck·lint·test·build, 아키텍처 경계, 타르볼 내용물을 검사한 뒤 npm에 배포합니다. 배포가 끝나면 그 태그로 GitHub Release를 만듭니다(노트는 직전 `v*` 태그 이후 PR로 자동 생성).

실패한 배포는 태그를 지우지 말고 `workflow_dispatch`로 다시 돌립니다. npm 배포는 성공했는데 Release 생성만 실패했다면, 그 실행에서 **Re-run failed jobs**를 누르세요.

## Self-dependency 주의

`package.json`의 `dependencies`에 이 패키지 자신(`claude-memory-layer`)을 넣지 마세요. 한번 `package-lock.json`에 들어가면 `npm install`이 계속 되살려 놓습니다.

- 진단: `npm list claude-memory-layer` 결과가 `(empty)`여야 정상입니다.
- 복구:

  ```bash
  # package.json에서 self-dependency를 지운 뒤
  rm package-lock.json && rm -rf node_modules
  npm install
  npm list claude-memory-layer
  ```

배포 워크플로는 `node scripts/guard-release-artifact.cjs self-dependency`로 이를 막습니다.

## 보안 문제

취약점은 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 절차로 제보해 주세요.
