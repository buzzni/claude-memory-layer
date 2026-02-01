# Private Tags Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 `<private>` 태그를 통한 명시적 프라이버시 제어 지원:

```markdown
<private>
API_KEY=sk-xxxx
</private>
```

**특징**:
- 사용자가 직접 비공개 영역 지정
- 태그 내 내용은 저장되지 않음
- 간단하고 직관적인 문법

### 1.2 현재 code-memory의 상황

현재 패턴 기반 필터링만 지원:

```typescript
const config = {
  privacy: {
    excludePatterns: ['password', 'secret', 'api_key']
  }
};
```

**한계**:
1. 고정된 패턴만 감지
2. 컨텍스트 무시 (실제 비밀번호 아닌 "password"도 필터링)
3. 사용자 의도 반영 불가

### 1.3 두 접근법 비교

| 패턴 기반 | 태그 기반 |
|----------|----------|
| 자동 감지 | 명시적 지정 |
| False positive 가능 | 정확한 제어 |
| 설정 필요 | 즉시 사용 |
| 패턴 외 누락 가능 | 사용자 책임 |

**결론**: 두 방식 병행이 최선

## 2. 태그 문법 선택

### 2.1 고려한 옵션들

| 옵션 | 예시 | 장점 | 단점 |
|------|------|------|------|
| XML 스타일 | `<private>...</private>` | 직관적, 중첩 가능 | Markdown과 충돌 가능 |
| 대괄호 | `[private]...[/private]` | Markdown 친화적 | 덜 직관적 |
| HTML 주석 | `<!-- private -->` | 렌더링 안 됨 | 복잡함 |
| 펜스 스타일 | `:::private\n...\n:::` | Markdown 확장 스타일 | 비표준 |

### 2.2 선택: XML 스타일 + 대안 지원

```typescript
// 기본: XML 스타일
<private>...</private>

// 대안 1: 대괄호 (Markdown 문서용)
[private]...[/private]

// 대안 2: HTML 주석 (렌더링 방지)
<!-- private -->...<!-- /private -->
```

### 2.3 claude-mem과의 호환성

claude-mem이 `<private>` 태그를 사용하므로 동일한 문법을 기본으로 채택하여 사용자 경험 일관성 유지.

## 3. 기존 코드와의 관계

### 3.1 types.ts

현재 Privacy 관련 타입:

```typescript
// 현재
export const PrivacyConfigSchema = z.object({
  excludePatterns: z.array(z.string()),
  anonymize: z.boolean()
});

// 확장
export const PrivacyConfigSchema = z.object({
  excludePatterns: z.array(z.string()),
  anonymize: z.boolean(),
  privateTags: PrivateTagsConfigSchema  // 추가
});
```

### 3.2 훅 연동

영향받는 훅:
- `user-prompt-submit.ts`: 사용자 입력 필터링
- `stop.ts`: AI 응답 필터링
- `post-tool-use.ts`: 도구 출력 필터링

```typescript
// 모든 훅에서 동일한 필터 사용
const filtered = applyPrivacyFilter(content, config.privacy);
```

### 3.3 검색 영향

- **벡터 검색**: `[PRIVATE]` 마커가 임베딩에 포함되지만, 원본 내용은 검색 불가
- **전문 검색**: 마커는 검색 가능, 원본 내용 불가

## 4. 설계 결정 사항

### 4.1 마커 선택

**옵션들**:
1. `[PRIVATE]` - 명확하고 검색 가능
2. `[REDACTED]` - 일반적인 검열 용어
3. `""` (빈 문자열) - 흔적 없이 제거
4. `[...]` - 간결하지만 모호

**선택**: `[PRIVATE]`
- 명확한 의미 전달
- 검색/필터링 가능
- 설정으로 변경 가능

### 4.2 코드 블록 처리

**문제**: 코드 블록 내 `<private>` 태그를 리터럴로 취급해야 함

```markdown
```xml
<private>이것은 예시 코드입니다</private>
```
```

**해결**: 코드 블록을 먼저 추출하고 보호

```typescript
// 1. 코드 블록 임시 치환
// 2. private 태그 파싱
// 3. 코드 블록 복원
```

### 4.3 불완전한 태그 처리

**시나리오**:
```markdown
<private>
시작은 있지만 끝이 없음...
(사용자가 실수로 닫지 않음)
```

**옵션**:
1. 끝까지 private로 처리 → 데이터 손실 위험
2. 무시 (원본 유지) → 보수적, 안전

**선택**: 무시 (보수적 접근)
- 데이터 손실 방지
- 사용자에게 경고 표시 가능

### 4.4 중첩 태그 처리

```markdown
<private>
외부
  <private>내부</private>
외부 계속
</private>
```

**선택**: 중첩 지원하지 않음
- 외부 태그만 처리
- 복잡도 감소
- 실용적 케이스 드묾

## 5. 성능 고려사항

### 5.1 정규식 성능

```typescript
// 비효율적 (매번 새 정규식)
for (const format of formats) {
  const regex = new RegExp(...);  // 매번 생성
}

// 효율적 (캐싱)
const TAG_PATTERNS = {
  xml: /<private>[\s\S]*?<\/private>/gi,
  // ...
};
```

### 5.2 대용량 텍스트

긴 텍스트의 경우:
- 정규식 `[\s\S]*?` 사용 (non-greedy)
- 스트리밍 파싱 고려 (향후)

### 5.3 캐싱

```typescript
// 동일 입력에 대한 결과 캐싱
const filterCache = new LRUCache<string, FilterResult>({
  max: 100,
  ttl: 60000
});
```

## 6. 보안 고려사항

### 6.1 태그 우회 시도

```markdown
<!-- 공격자가 태그를 깨뜨리려는 시도 -->
<private
>secret</private>

<pri
vate>secret</private>
```

**대응**: 엄격한 정규식 매칭 (정확한 `<private>` 패턴만)

### 6.2 메모리 내 노출

- 파싱 중 원본 내용이 메모리에 일시적으로 존재
- 디스크에는 저장되지 않음
- 로그에 원본 출력 금지

```typescript
// 안전하지 않음
console.log(`Parsing: ${content}`);

// 안전
console.log(`Parsing content of length ${content.length}`);
```

## 7. 사용자 경험

### 7.1 문서화

```markdown
## Privacy Tags

Wrap sensitive content in `<private>` tags to prevent storage:

\`\`\`
<private>
Your sensitive data here
</private>
\`\`\`

Content inside these tags will NOT be stored in memory.
```

### 7.2 피드백

```typescript
// 훅에서 사용자에게 피드백
if (filterResult.metadata.privateTagCount > 0) {
  return {
    message: `🔒 ${filterResult.metadata.privateTagCount} private section(s) excluded from memory`
  };
}
```

### 7.3 경고

```typescript
// 불완전한 태그 감지
if (hasUnmatchedOpenTag(content)) {
  return {
    warning: '⚠️ Unclosed <private> tag detected. Content was NOT filtered.'
  };
}
```

## 8. 참고 자료

- **claude-mem README**: Privacy controls using `<private>` tags
- **OWASP**: Sensitive Data Exposure guidelines
- **GDPR**: Right to erasure (잊혀질 권리)
