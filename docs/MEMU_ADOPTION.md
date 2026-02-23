# memU Adoption Notes (claude-memory-layer)

이 프로젝트에 적용된 memU 장점 요약입니다.

## 1) Dual Retrieval Strategy
- `strategy: "fast" | "deep" | "auto"`
- `fast`: 키워드 기반(FTS/keyword) 우선 탐색으로 저지연 검색
- `deep`: 임베딩 + 벡터 검색 + 재정렬(키워드 오버랩 가중)로 정밀 검색

## 2) Scoped Retrieval Filters
`scope`로 검색 범위를 좁혀 정확도를 높입니다.

- `sessionId` / `sessionIdPrefix`
- `eventTypes`
- `canonicalKeyPrefix`
- `contentIncludes` (부분 문자열 OR)
- `metadata` (dot-path, 예: `scope.project.id`)

## 3) Hybrid Rerank Behavior
`rerankWithKeyword=true`일 때 semantic score에 키워드 오버랩/최근성 점수를 가중해 재정렬합니다.

## 4) Test Coverage
- `tests/retriever.memu-adoption.test.ts`
  - metadata dot-path 스코프 필터
  - fast 전략 키워드 경로
- `tests/retriever-strategy-scope.test.ts`
  - fast/deep 전략 및 복합 스코프 필터

## Quick Example
```ts
await retriever.retrieve('브리핑', {
  strategy: 'deep',
  topK: 10,
  scope: {
    sessionIdPrefix: 'agent:main:',
    canonicalKeyPrefix: 'pref/briefing',
    metadata: { 'scope.project.id': 'alpha' }
  }
});
```
