# Code Memory - Project Instructions

## Common Mistakes to Avoid

### ⚠️ Self-dependency in package.json (반복 발생 주의!)
- **절대로** package.json의 dependencies에 자기 자신의 패키지를 추가하지 말 것
- 예: `"claude-memory-layer": "^1.0.x"` 같은 순환 의존성 금지
- npm list 시 이상한 중첩 구조가 보이면 self-dependency 의심할 것

#### 원인
- `package-lock.json`에 self-dependency가 저장되면, `npm install` 시 package.json에 복원됨
- 한번 잘못 들어가면 lock 파일 때문에 계속 복원되는 악순환 발생

#### 해결 방법
```bash
# 1. package.json에서 self-dependency 제거
# 2. lock 파일과 node_modules 삭제
rm package-lock.json && rm -rf node_modules
# 3. 새로 설치
npm install
# 4. 확인 (empty가 나와야 정상)
npm list claude-memory-layer
```

## npm Publish Workflow

기본 경로는 **태그 푸시 → GitHub Actions**다. 로컬에서 `npm publish`를 직접 실행하지 말 것 — OTP 없이 재현 가능하고, provenance가 붙고, 가드가 항상 동일하게 돌아간다.

1. 변경사항을 main에 머지 (CI 통과 필수)
2. main에서 버전 올리고 커밋:
   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   git commit -am "chore(release): v$(node -p "require('./package.json').version")"
   git push origin main
   ```
3. 태그 푸시 → 배포가 자동 시작됨:
   ```bash
   git tag "v$(node -p "require('./package.json').version")"
   git push origin "v$(node -p "require('./package.json').version")"
   ```
4. 진행 확인: `gh run watch` 또는 Actions 탭의 "Publish to npm"
5. 확인: `npm view claude-memory-layer versions`

`.github/workflows/publish-npm.yml`이 배포 전에 강제하는 것: 태그와 package.json 버전 일치, 이미 배포된 버전인지, self-dependency, `npm audit --omit=dev`, typecheck·lint·test·build, 아키텍처 경계, 타르볼 내용물. 배포 후에는 레지스트리 전파와 신규 설치 스모크 테스트까지 확인한다. 실패한 배포는 태그를 지웠다 다시 만들 필요 없이 `workflow_dispatch`로 재실행하면 된다.

### 로컬 배포 (예외 경로)
`npm run release:npm -- --otp=<코드>` 는 위 가드에 더해 관리형 임베딩 백엔드 audit까지 수행한다(실제 postinstall 다운로드가 필요해 CI에서는 못 도는 검사). 백엔드 패키징을 건드렸을 때만 이 경로를 쓸 것.

두 경로 모두 `scripts/guard-release-artifact.cjs`의 동일한 가드를 호출한다.
