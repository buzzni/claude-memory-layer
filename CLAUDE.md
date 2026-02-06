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
1. Self-dependency 확인: `npm list claude-memory-layer` → `(empty)` 확인
2. 버전 업데이트: package.json 직접 수정 또는 `npm version patch`
3. 빌드: `npm run build`
4. 배포: `npm publish --otp=<코드>`
5. 확인: `npm view claude-memory-layer versions`
