# Plan: Selective Storage Filtering

## 구현 범위

3개 파일 수정, 스키마 변경 없음.

---

## Step 1. post-tool-use.ts — blocklist 확장 + output 필터

### 1-1. DEFAULT_CONFIG 업데이트

```ts
const DEFAULT_CONFIG: Config['toolObservation'] = {
  enabled: true,
  excludedTools: [
    // 기존
    'TodoWrite', 'TodoRead',
    // 추가: 재현 가능한 조회 도구
    'Read', 'Grep', 'Glob',
    'ToolSearch', 'WebFetch', 'WebSearch', 'NotebookRead',
    // 추가: 저가치 시스템 도구
    'Skill', 'EnterPlanMode',
  ],
  minOutputLength: parseInt(process.env.CLAUDE_MEMORY_TOOL_MIN_OUTPUT_LEN || '100'),
  maxOutputLength: 10000,
  maxOutputLines: 100,
  storeOnlyOnSuccess: false
};
```

### 1-2. 환경변수 오버라이드

```ts
const envBlocklist = process.env.CLAUDE_MEMORY_TOOL_BLOCKLIST;
if (envBlocklist) {
  config.excludedTools = envBlocklist.split(',').map(s => s.trim());
}
```

### 1-3. ALWAYS_STORE 집합 + hasSignificantOutput 함수

```ts
const ALWAYS_STORE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Agent', 'Task', 'ExitPlanMode'
]);

function hasSignificantOutput(
  toolName: string,
  output: string,
  response: PostToolUseInput['tool_response'],
  minLen: number
): boolean {
  if (ALWAYS_STORE_TOOLS.has(toolName)) return true;
  if (response?.stderr && response.stderr.trim().length > 0) return true;
  return output.trim().length >= minLen;
}
```

### 1-4. main() — step 4.5 위치에 output 필터 삽입

```ts
// 기존 step 4 (success filter) 다음에 추가
// 4.5. output-level 필터
if (!hasSignificantOutput(
  input.tool_name, toolOutput, input.tool_response,
  config.minOutputLength ?? 100
)) {
  console.log(JSON.stringify({}));
  return;
}
```

---

## Step 2. stop.ts — agent_response min-length 필터

### 변경 위치: storeAgentResponse 루프 내

```ts
const MIN_AGENT_RESPONSE_LEN = parseInt(
  process.env.CLAUDE_MEMORY_AGENT_RESPONSE_MIN_LEN || '150'
);

// Store each assistant response
const lastIdx = assistantMessages.length - 1;
for (let i = 0; i < assistantMessages.length; i++) {
  const text = assistantMessages[i];
  const isLast = i === lastIdx;

  // 마지막 메시지는 최종 답변일 수 있으므로 길이 무관 저장
  if (!isLast && text.trim().length < MIN_AGENT_RESPONSE_LEN) continue;

  // ... 기존 privacy filter, truncate, store 로직
}
```

---

## Step 3. session-history-importer.ts — shouldStorePrompt 적용

### 변경 위치: user_prompt 저장 전

```ts
// shouldStorePrompt와 동일한 로직 인라인 적용
function isWorthStoringPrompt(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith('/')) return false;
  if (trimmed.length < 15) return false;
  if (!/[a-zA-Z가-힣]{2,}/.test(trimmed)) return false;
  return true;
}

// importer 루프 내 user role 메시지 처리 시:
if (message.role === 'user') {
  const textContent = extractTextContent(message);
  if (!isWorthStoringPrompt(textContent)) continue; // 추가
  await service.storeUserPrompt(sessionId, textContent, ...);
}
```

> 참고: `shouldStorePrompt`를 `user-prompt-submit.ts`에서 공유 유틸로 추출하면
> 중복 없이 재사용 가능. 단, 임포터만 수정하는 경우엔 인라인도 무방.

---

## 구현 순서

1. `src/hooks/post-tool-use.ts` 수정 (Step 1)
2. `src/hooks/stop.ts` 수정 (Step 2)
3. `src/services/session-history-importer.ts` 수정 (Step 3)
4. `npm run build`
5. 검증

---

## 리스크 및 대응

| 리스크 | 대응 |
|--------|------|
| Read 결과가 필요한 경우 | agent_response에 내용이 반영됨. Read 자체보다 해석이 더 가치 있음 |
| Grep 결과 패턴 필요 | user_prompt + agent_response에 충분한 맥락 있음 |
| 짧은 agent_response가 중요한 경우 | 마지막 메시지 예외 처리로 커버 |
| importer 소급 필터 없음 | 신규 import부터 적용, 기존 데이터 유지 |
| 환경변수로 비활성화 가능 | `CLAUDE_MEMORY_TOOL_BLOCKLIST=""` 로 전체 허용 가능 |

---

## 검증 기준

- `npm run build` 성공
- Read/Grep/Glob 도구 사용 후 tool_observation 미생성 확인
- Bash 에러 발생 시 tool_observation 생성 확인
- Write/Edit 실행 시 tool_observation 생성 확인
- 짧은 agent_response (< 150자) 저장 안 됨 확인
- 마지막 agent_response는 길이 무관 저장 확인
- import 시 '1', 'go', Ctrl+C 저장 안 됨 확인
- dashboard stats tool_observation 비율 감소 추세 확인
