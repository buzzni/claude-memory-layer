# Claude Memory Layer - 작업 핸드오프 문서

## 현재 상태
**날짜**: 2026-02-01
**상태**: SQLite WAL 마이그레이션 완료 ✅

## 문제 해결 완료

### 기존 문제
- DuckDB 다중 프로세스 동시 접근 충돌
- 웹 대시보드 (localhost:37777)에서 500 에러
- 훅과 서버 동시 실행 불가

### 해결책: 2-tier 스토리지 아키텍처
```
Hooks (쓰기) ──▶ SQLite (WAL) ◀── Server (읽기)
                     │
                     └── 동시 접근 가능 ✅
```

## 구현된 변경사항

### 새 파일
1. **`src/core/sqlite-wrapper.ts`** - SQLite WAL 모드 래퍼
2. **`src/core/sqlite-event-store.ts`** - SQLite 기반 EventStore
3. **`src/core/sync-worker.ts`** - SQLite→DuckDB 동기화 워커 (미래 분석용)

### 수정된 파일
1. **`src/services/memory-service.ts`** - 이중 스토어 아키텍처 통합
   - `sqliteStore`: Primary store (항상 사용)
   - `analyticsStore`: DuckDB (옵션, 분석용)
   - `analyticsEnabled` 옵션 추가

2. **`src/core/index.ts`** - 새 모듈 export

3. **`scripts/build.ts`** - better-sqlite3 external 추가

4. **`package.json`** - better-sqlite3 의존성 추가

## 테스트 결과
```bash
# 서버 실행 중 훅 테스트
$ node dist/server/index.js &
$ echo '{"session_id":"test","prompt":"test","cwd":"/tmp"}' | node dist/hooks/user-prompt-submit.js
{"context":""}  # 성공!

# 동시 실행 테스트 (5개 훅 병렬)
All hooks completed ✅
eventCount: 7
```

## 아키텍처 결정

### Primary Store: SQLite (WAL 모드)
- 훅에서 직접 쓰기
- 서버에서 직접 읽기
- WAL 모드: 다중 리더 + 단일 라이터 지원
- 락 충돌 없음

### Analytics Store: DuckDB (옵션, 미래용)
- 복잡한 분석 쿼리용
- 배치 동기화 (SyncWorker)
- 현재는 비활성화

## 빌드 및 실행

```bash
# 빌드
npm run build

# 서버 시작
node dist/server/index.js

# 훅 테스트 (서버 실행 중에도 가능!)
echo '{"session_id":"test","prompt":"test","cwd":"/tmp"}' | node dist/hooks/user-prompt-submit.js

# 대시보드
open http://localhost:37777
```

## 향후 작업 (선택사항)

1. **DuckDB 분석 기능 활성화**
   - SyncWorker로 SQLite→DuckDB 동기화
   - 복잡한 통계/분석 쿼리에 DuckDB 사용

2. **Shared Store SQLite 마이그레이션**
   - 현재: 훅에서 비활성화
   - 향후: SQLite 기반으로 전환

3. **마이그레이션 도구**
   - 기존 DuckDB 데이터를 SQLite로 마이그레이션
