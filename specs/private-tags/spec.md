# Private Tags Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 프라이버시 필터링의 한계:

1. **패턴 기반만 지원**: `password`, `api_key` 등 고정 패턴만 필터링
2. **사용자 제어 부족**: 특정 내용을 명시적으로 제외할 방법 없음
3. **컨텍스트 무시**: 의도적으로 공유하고 싶지 않은 대화 부분 지정 불가

### 1.2 해결 방향

**명시적 `<private>` 태그 지원**:
- 사용자가 직접 비공개 영역 지정
- 태그 내 내용은 메모리에 저장되지 않음
- 패턴 기반 필터링과 병행

## 2. 핵심 개념

### 2.1 태그 문법

```markdown
이것은 저장됩니다.

<private>
이 부분은 메모리에 저장되지 않습니다.
API_KEY=sk-xxxx
SECRET_TOKEN=abc123
</private>

이것도 저장됩니다.
```

### 2.2 태그 변형

```typescript
// 지원하는 태그 형식
const PRIVATE_TAG_PATTERNS = [
  /<private>[\s\S]*?<\/private>/gi,           // 기본
  /<private\s*\/>[\s\S]*?<\/private>/gi,      // self-closing 시작
  /\[private\][\s\S]*?\[\/private\]/gi,       // 대괄호 형식
  /<!--\s*private\s*-->[\s\S]*?<!--\s*\/private\s*-->/gi  // HTML 주석 형식
];
```

### 2.3 중첩 처리

```markdown
<private>
외부 비공개
  <private>
  중첩된 비공개 (지원하지 않음 - 외부 태그만 처리)
  </private>
내용 계속
</private>
```

## 3. 처리 로직

### 3.1 파싱 알고리즘

```typescript
interface PrivateSection {
  start: number;
  end: number;
  content: string;
}

function findPrivateSections(text: string): PrivateSection[] {
  const sections: PrivateSection[] = [];
  const regex = /<private>([\s\S]*?)<\/private>/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    sections.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1]
    });
  }

  return sections;
}

function removePrivateSections(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, '[PRIVATE]');
}
```

### 3.2 저장 전 필터링

```typescript
async function storeWithPrivacyFilter(content: string): Promise<string> {
  // 1. <private> 태그 제거
  let filtered = removePrivateSections(content);

  // 2. 패턴 기반 필터링 (기존)
  filtered = maskSensitivePatterns(filtered);

  // 3. 빈 줄 정리
  filtered = filtered.replace(/\n{3,}/g, '\n\n');

  return filtered;
}
```

### 3.3 마커 옵션

```typescript
interface PrivacyConfig {
  privateTag: {
    enabled: boolean;
    marker: '[PRIVATE]' | '[REDACTED]' | '';  // 대체 텍스트
    preserveStructure: boolean;  // 줄바꿈 유지 여부
  };
}

// preserveStructure: true
"Before\n<private>\nSecret\nData\n</private>\nAfter"
→ "Before\n[PRIVATE]\n\n\nAfter"

// preserveStructure: false
"Before\n<private>\nSecret\nData\n</private>\nAfter"
→ "Before\n[PRIVATE]\nAfter"
```

## 4. 데이터 스키마

### 4.1 이벤트 메타데이터

```typescript
const EventPayloadSchema = z.object({
  content: z.string(),
  // 프라이버시 메타데이터 추가
  privacy: z.object({
    hasPrivateSections: z.boolean(),
    privateCount: z.number(),
    originalLength: z.number(),
    filteredLength: z.number()
  }).optional()
});
```

### 4.2 통계

```typescript
interface PrivacyStats {
  totalPrivateSections: number;
  totalCharactersFiltered: number;
  sessionsWithPrivate: number;
}
```

## 5. 사용 시나리오

### 5.1 API 키 보호

```markdown
User: 이 API 키로 요청해줘

<private>
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx
</private>

응답 형식은 JSON으로 해줘.
```

**저장 결과**:
```
User: 이 API 키로 요청해줘

[PRIVATE]

응답 형식은 JSON으로 해줘.
```

### 5.2 민감한 비즈니스 로직

```markdown
User: 다음 알고리즘을 최적화해줘

<private>
// 회사 기밀 알고리즘
function proprietaryAlgorithm() {
  // ...
}
</private>

특히 시간 복잡도를 개선하고 싶어.
```

### 5.3 개인 정보

```markdown
User: 이메일 템플릿 작성해줘

<private>
받는 사람: john.doe@company.com
참조: secret-team@company.com
</private>

공식적인 톤으로 작성해줘.
```

## 6. 검색 영향

### 6.1 벡터 검색

- `[PRIVATE]` 마커는 임베딩에 포함
- 원본 private 내용은 검색 불가
- 주변 컨텍스트는 검색 가능

### 6.2 전문 검색 (FTS)

```sql
-- [PRIVATE] 마커 제외 검색
SELECT * FROM events_fts
WHERE content MATCH :query
  AND content NOT LIKE '%[PRIVATE]%';

-- 또는 마커 포함 결과도 표시
SELECT * FROM events_fts
WHERE content MATCH :query;
```

## 7. UI 표시

### 7.1 CLI 출력

```
$ code-memory history

[2026-02-01 14:00] User Prompt
  이 API 키로 요청해줘
  [🔒 PRIVATE CONTENT REDACTED]
  응답 형식은 JSON으로 해줘.
```

### 7.2 Web Viewer

```html
<div class="event-content">
  <p>이 API 키로 요청해줘</p>
  <div class="private-marker">
    <span class="icon">🔒</span>
    <span>Private content (not stored)</span>
  </div>
  <p>응답 형식은 JSON으로 해줘.</p>
</div>
```

## 8. 설정

### 8.1 설정 스키마

```typescript
const PrivacyConfigSchema = z.object({
  // 기존 패턴 기반 필터링
  excludePatterns: z.array(z.string()).default([
    'password', 'secret', 'api_key', 'token', 'bearer'
  ]),

  // 새로운 태그 기반 필터링
  privateTags: z.object({
    enabled: z.boolean().default(true),
    marker: z.enum(['[PRIVATE]', '[REDACTED]', '']).default('[PRIVATE]'),
    preserveLineCount: z.boolean().default(false),
    supportedFormats: z.array(z.enum([
      'xml',      // <private>
      'bracket',  // [private]
      'comment'   // <!-- private -->
    ])).default(['xml'])
  }),

  // 자동 감지
  autoDetect: z.object({
    enabled: z.boolean().default(true),
    patterns: z.array(z.string())  // 정규식
  }).optional()
});
```

### 8.2 설정 예시

```json
{
  "privacy": {
    "excludePatterns": ["password", "secret", "api_key"],
    "privateTags": {
      "enabled": true,
      "marker": "[PRIVATE]",
      "supportedFormats": ["xml", "bracket"]
    }
  }
}
```

## 9. 경계 케이스

### 9.1 불완전한 태그

```markdown
<private>
시작은 있지만 끝이 없음
```
→ 끝까지 private로 처리? 또는 무시?

**결정**: 불완전한 태그는 무시 (보수적 접근)

### 9.2 코드 블록 내 태그

```markdown
```python
# 예시 코드
print("<private>not actually private</private>")
```
```

**결정**: 코드 블록 내 태그는 무시 (리터럴로 취급)

### 9.3 빈 태그

```markdown
<private></private>
<private>   </private>
```

**결정**: 빈 태그는 완전히 제거 (마커도 남기지 않음)

## 10. 성공 기준

- [ ] `<private>` 태그 내 내용이 메모리에 저장되지 않음
- [ ] `[PRIVATE]` 마커로 대체됨
- [ ] 기존 패턴 기반 필터링과 병행 동작
- [ ] 불완전한 태그 안전하게 처리
- [ ] 코드 블록 내 태그 무시
- [ ] 통계에 필터링 정보 포함
- [ ] CLI와 Web UI에서 적절히 표시
