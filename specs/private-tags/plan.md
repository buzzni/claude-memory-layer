# Private Tags Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 파서 구현 (P0)

### 1.1 태그 파서

**파일**: `src/core/privacy/tag-parser.ts` (신규)

```typescript
export interface PrivateSection {
  start: number;
  end: number;
  content: string;
  format: 'xml' | 'bracket' | 'comment';
}

export interface ParseResult {
  filtered: string;
  sections: PrivateSection[];
  stats: {
    count: number;
    totalLength: number;
  };
}

const TAG_PATTERNS: Record<string, RegExp> = {
  xml: /<private>([\s\S]*?)<\/private>/gi,
  bracket: /\[private\]([\s\S]*?)\[\/private\]/gi,
  comment: /<!--\s*private\s*-->([\s\S]*?)<!--\s*\/private\s*-->/gi
};

export function parsePrivateTags(
  text: string,
  options: { formats: string[]; marker: string }
): ParseResult {
  const sections: PrivateSection[] = [];
  let filtered = text;

  for (const format of options.formats) {
    const pattern = TAG_PATTERNS[format];
    if (!pattern) continue;

    let match;
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;

    while ((match = pattern.exec(text)) !== null) {
      sections.push({
        start: match.index,
        end: match.index + match[0].length,
        content: match[1],
        format: format as PrivateSection['format']
      });
    }
  }

  // 모든 태그 제거 및 마커로 대체
  for (const format of options.formats) {
    const pattern = TAG_PATTERNS[format];
    filtered = filtered.replace(pattern, (match, content) => {
      // 빈 태그는 완전히 제거
      if (!content.trim()) return '';
      return options.marker;
    });
  }

  return {
    filtered,
    sections,
    stats: {
      count: sections.length,
      totalLength: sections.reduce((sum, s) => sum + s.content.length, 0)
    }
  };
}
```

**작업 항목**:
- [ ] parsePrivateTags 함수 구현
- [ ] 각 포맷별 정규식 테스트
- [ ] 중첩 태그 처리

### 1.2 코드 블록 보호

**파일**: `src/core/privacy/tag-parser.ts` 계속

```typescript
export function parsePrivateTagsSafe(
  text: string,
  options: { formats: string[]; marker: string }
): ParseResult {
  // 1. 코드 블록 임시 치환
  const codeBlocks: string[] = [];
  const textWithPlaceholders = text.replace(
    /```[\s\S]*?```/g,
    (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    }
  );

  // 2. private 태그 파싱
  const result = parsePrivateTags(textWithPlaceholders, options);

  // 3. 코드 블록 복원
  result.filtered = result.filtered.replace(
    /__CODE_BLOCK_(\d+)__/g,
    (_, idx) => codeBlocks[Number(idx)]
  );

  return result;
}
```

**작업 항목**:
- [ ] 코드 블록 감지 및 보호
- [ ] 인라인 코드 처리
- [ ] 복원 로직

## Phase 2: 설정 통합 (P0)

### 2.1 설정 스키마 확장

**파일**: `src/core/types.ts` 수정

```typescript
export const PrivateTagsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  marker: z.enum(['[PRIVATE]', '[REDACTED]', '']).default('[PRIVATE]'),
  preserveLineCount: z.boolean().default(false),
  supportedFormats: z.array(
    z.enum(['xml', 'bracket', 'comment'])
  ).default(['xml'])
});

// PrivacyConfigSchema 확장
export const PrivacyConfigSchema = z.object({
  excludePatterns: z.array(z.string()).default([...]),
  privateTags: PrivateTagsConfigSchema.optional(),
  // ...
});
```

**작업 항목**:
- [ ] PrivateTagsConfigSchema 추가
- [ ] 기본값 설정
- [ ] 설정 마이그레이션

## Phase 3: 필터링 파이프라인 (P0)

### 3.1 통합 필터

**파일**: `src/core/privacy/filter.ts` (신규 또는 확장)

```typescript
export interface FilterResult {
  content: string;
  metadata: {
    hasPrivateTags: boolean;
    privateTagCount: number;
    patternMatchCount: number;
    originalLength: number;
    filteredLength: number;
  };
}

export function applyPrivacyFilter(
  content: string,
  config: PrivacyConfig
): FilterResult {
  let filtered = content;
  let privateTagCount = 0;
  let patternMatchCount = 0;

  // 1. Private 태그 필터링
  if (config.privateTags?.enabled) {
    const tagResult = parsePrivateTagsSafe(filtered, {
      formats: config.privateTags.supportedFormats,
      marker: config.privateTags.marker
    });
    filtered = tagResult.filtered;
    privateTagCount = tagResult.stats.count;
  }

  // 2. 패턴 기반 필터링
  for (const pattern of config.excludePatterns) {
    const regex = new RegExp(
      `(${pattern})\\s*[:=]\\s*['"]?[^\\s'"]+`,
      'gi'
    );
    const matches = filtered.match(regex);
    if (matches) {
      patternMatchCount += matches.length;
      filtered = filtered.replace(regex, '[REDACTED]');
    }
  }

  // 3. 연속 마커 정리
  filtered = filtered.replace(/(\[PRIVATE\]\s*)+/g, '[PRIVATE]\n');
  filtered = filtered.replace(/(\[REDACTED\]\s*)+/g, '[REDACTED] ');

  return {
    content: filtered,
    metadata: {
      hasPrivateTags: privateTagCount > 0,
      privateTagCount,
      patternMatchCount,
      originalLength: content.length,
      filteredLength: filtered.length
    }
  };
}
```

**작업 항목**:
- [ ] applyPrivacyFilter 함수 구현
- [ ] 태그 + 패턴 조합 필터링
- [ ] 마커 정리 로직

### 3.2 훅 연동

**파일**: `src/hooks/stop.ts` 수정

```typescript
import { applyPrivacyFilter } from '../core/privacy/filter';

export async function handleStop(input: StopInput): Promise<void> {
  const memoryService = await MemoryService.getInstance();
  const config = await memoryService.getConfig();

  // 응답 내용 필터링
  const filterResult = applyPrivacyFilter(
    input.response_content,
    config.privacy
  );

  // 필터링된 내용 저장
  await memoryService.storeResponse({
    content: filterResult.content,
    privacy: filterResult.metadata
  });
}
```

**작업 항목**:
- [ ] stop 훅에 필터링 적용
- [ ] user-prompt-submit 훅에 필터링 적용
- [ ] 메타데이터 저장

## Phase 4: UI 표시 (P1)

### 4.1 CLI 출력

**파일**: `src/cli/commands/history.ts` 수정

```typescript
function formatEventContent(event: Event): string {
  const content = event.payload.content;

  // [PRIVATE] 마커 강조
  return content.replace(
    /\[PRIVATE\]/g,
    chalk.yellow('[🔒 PRIVATE]')
  );
}
```

**작업 항목**:
- [ ] CLI에서 마커 강조
- [ ] 통계 표시 옵션

### 4.2 Web Viewer

**파일**: `src/ui/components/EventContent.ts` 수정

```typescript
function EventContent({ content }) {
  // [PRIVATE] 마커를 컴포넌트로 변환
  const parts = content.split(/(\[PRIVATE\])/g);

  return h('div', { class: 'event-content' },
    parts.map(part =>
      part === '[PRIVATE]'
        ? h('span', { class: 'private-marker' }, '🔒 Private content')
        : h('span', {}, part)
    )
  );
}
```

**작업 항목**:
- [ ] 마커를 시각적 컴포넌트로 변환
- [ ] 툴팁 추가

## Phase 5: 통계 및 모니터링 (P1)

### 5.1 통계 수집

**파일**: `src/services/memory-service.ts` 수정

```typescript
export class MemoryService {
  async getPrivacyStats(): Promise<PrivacyStats> {
    const events = await this.eventStore.query({
      filter: { 'payload.privacy.hasPrivateTags': true }
    });

    return {
      totalPrivateSections: events.reduce(
        (sum, e) => sum + (e.payload.privacy?.privateTagCount || 0),
        0
      ),
      totalCharactersFiltered: events.reduce(
        (sum, e) => sum + (
          (e.payload.privacy?.originalLength || 0) -
          (e.payload.privacy?.filteredLength || 0)
        ),
        0
      ),
      sessionsWithPrivate: new Set(events.map(e => e.sessionId)).size
    };
  }
}
```

**작업 항목**:
- [ ] 프라이버시 통계 수집
- [ ] Stats API에 추가
- [ ] 대시보드 표시

## 파일 목록

### 신규 파일
```
src/core/privacy/tag-parser.ts   # 태그 파서
src/core/privacy/filter.ts       # 통합 필터 (기존 확장 가능)
```

### 수정 파일
```
src/core/types.ts                # 설정 스키마
src/hooks/stop.ts                # 응답 필터링
src/hooks/user-prompt-submit.ts  # 프롬프트 필터링
src/cli/commands/history.ts      # CLI 표시
src/ui/components/EventContent.ts # Web 표시
src/services/memory-service.ts   # 통계
```

## 테스트

### 필수 테스트 케이스

1. **기본 태그 파싱**
   ```typescript
   test('should remove private tag content', () => {
     const result = parsePrivateTags(
       'before <private>secret</private> after',
       { formats: ['xml'], marker: '[PRIVATE]' }
     );
     expect(result.filtered).toBe('before [PRIVATE] after');
   });
   ```

2. **코드 블록 보호**
   ```typescript
   test('should not parse tags inside code blocks', () => {
     const result = parsePrivateTagsSafe(
       '```\n<private>code</private>\n```',
       { formats: ['xml'], marker: '[PRIVATE]' }
     );
     expect(result.filtered).toContain('<private>code</private>');
   });
   ```

3. **불완전한 태그**
   ```typescript
   test('should ignore incomplete tags', () => {
     const result = parsePrivateTags(
       '<private>no closing tag',
       { formats: ['xml'], marker: '[PRIVATE]' }
     );
     expect(result.filtered).toBe('<private>no closing tag');
   });
   ```

4. **빈 태그**
   ```typescript
   test('should remove empty tags completely', () => {
     const result = parsePrivateTags(
       'text <private></private> more',
       { formats: ['xml'], marker: '[PRIVATE]' }
     );
     expect(result.filtered).toBe('text  more');
   });
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 태그 파서 구현 |
| M2 | 코드 블록 보호 |
| M3 | 설정 통합 |
| M4 | 훅 연동 |
| M5 | CLI 표시 |
| M6 | Web 표시 |
| M7 | 통계 수집 |
| M8 | 테스트 통과 |
