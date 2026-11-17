# Changelog

이 프로젝트의 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르고, 버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

각 항목은 해당 릴리스에 들어간 PR 제목입니다. `feat`는 Added, `fix`는 Fixed, 저장·전송되는 사용자 데이터에서 비밀값이나 개인정보가 새는 것을 막는 수정은 Security, `refactor`·`chore`는 Changed에 둡니다. 테스트·문서만 바꾼 PR은 생략합니다.
2.5.0 이전 릴리스는 [git 태그](https://github.com/buzzni/claude-memory-layer/tags)를 참고하세요.

## [Unreleased]

## [2.5.11] - 2026-11-17

### Added

- feat: sanitize recalled memory text at render time (hooks, MCP, dashboard chat) ([#201](https://github.com/buzzni/claude-memory-layer/pull/201))
- feat: Claude Code plugin marketplace install (memory-layer@claude-memory-layer) ([#197](https://github.com/buzzni/claude-memory-layer/pull/197))
- feat(hooks): checkpoint the session on PreCompact and re-inject it after compaction ([#212](https://github.com/buzzni/claude-memory-layer/pull/212))
- feat(llm): provider circuit breaker with kept session summaries ([#220](https://github.com/buzzni/claude-memory-layer/pull/220))
- feat(hooks): PreToolUse pre-edit check that recalls what earlier sessions left about a file ([#224](https://github.com/buzzni/claude-memory-layer/pull/224))
- feat(recall): label recalled memories by source trust, with an opt-in filter for automatic injection ([#226](https://github.com/buzzni/claude-memory-layer/pull/226))
- feat(hooks): opt-in capture policy for subagent and teammate tool calls ([#236](https://github.com/buzzni/claude-memory-layer/pull/236))
- feat(eval): RRF and local cross-encoder ranking evaluation (T12 stage 1, no ranking change) ([#239](https://github.com/buzzni/claude-memory-layer/pull/239))
- feat(lesson): share curated lessons through git-tracked files (lesson export / import) ([#243](https://github.com/buzzni/claude-memory-layer/pull/243))
- feat(repair): backfill-vectors, for events semantic search cannot reach ([#237](https://github.com/buzzni/claude-memory-layer/pull/237))

### Fixed

- fix(hooks): capture without LanceDB, native-module checks in doctor, lighter PostToolUse start ([#242](https://github.com/buzzni/claude-memory-layer/pull/242))
- fix(hooks): search other sessions in the semantic lane, and record when it fails ([#238](https://github.com/buzzni/claude-memory-layer/pull/238))

### Security

- fix(dashboard): add a Host allow-list (DNS rebinding defense) ([#218](https://github.com/buzzni/claude-memory-layer/pull/218))

## [2.5.10] - 2026-11-17

### Added

- `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and a GitHub Release created from each published `v*` tag

### Fixed

- fix(deps): update hono and @hono/node-server past the advisories blocking publish ([#200](https://github.com/buzzni/claude-memory-layer/pull/200))

## [2.5.9] - 2026-11-17

태그만 만들어졌고 npm에는 배포되지 않았습니다. 배포 워크플로가 `npm audit --omit=dev`에서 멈췄고([#200](https://github.com/buzzni/claude-memory-layer/pull/200)), 아래 변경은 2.5.10으로 처음 배포됐습니다.

### Added

- feat: make session-summary provider failures visible (telemetry, doctor, audit) ([#185](https://github.com/buzzni/claude-memory-layer/pull/185))

### Fixed

- fix: long prompts timing out the prompt hook, lost prompts, and the model re-download loop ([#196](https://github.com/buzzni/claude-memory-layer/pull/196))

## [2.5.8] - 2026-11-08

### Fixed

- fix(sqlite): sweep read snapshots left behind by exited processes ([#186](https://github.com/buzzni/claude-memory-layer/pull/186))

## [2.5.7] - 2026-11-07

### Fixed

- fix(llm): drop inherited host-session markers before spawning the CLI provider ([#183](https://github.com/buzzni/claude-memory-layer/pull/183))

## [2.5.6] - 2026-11-07

### Security

- fix(import): privacy-filter merged responses of sessions the hooks never saw ([#180](https://github.com/buzzni/claude-memory-layer/pull/180))

## [2.5.5] - 2026-11-07

### Fixed

- fix(mongo-sync): pull each origin past its own cursor so late documents are never skipped ([#178](https://github.com/buzzni/claude-memory-layer/pull/178))
- fix(import): store a hook-stored session's responses the way the reconcile does ([#177](https://github.com/buzzni/claude-memory-layer/pull/177))
- fix(hooks): keep and retry SessionEnd jobs whose handler fails to load ([#176](https://github.com/buzzni/claude-memory-layer/pull/176))
- fix(prompt-normalizer): classify banner-wrapped task notifications as task_notification ([#175](https://github.com/buzzni/claude-memory-layer/pull/175))
- fix(postinstall): spawn npm on Windows without tripping CVE-2024-27980 ([#174](https://github.com/buzzni/claude-memory-layer/pull/174))
- fix(eval): write path refs instead of absolute paths in evaluation outputs ([#172](https://github.com/buzzni/claude-memory-layer/pull/172))
- fix(hooks): inject each memory at most once per prompt ([#156](https://github.com/buzzni/claude-memory-layer/pull/156))

### Changed

- chore(claude-transcript): remove tail-read helpers left unused by the Stop cursor ([#170](https://github.com/buzzni/claude-memory-layer/pull/170))

## [2.5.4] - 2026-11-07

### Added

- feat(session-start): use the runbook index on the native path once a project has runbooks ([#168](https://github.com/buzzni/claude-memory-layer/pull/168))

### Fixed

- fix(vectors): stop embedding every event twice ([#167](https://github.com/buzzni/claude-memory-layer/pull/167))

## [2.5.3] - 2026-11-07

### Added

- feat(mcp): serve read-only retrieval through the semantic daemon instead of lexical-only ([#165](https://github.com/buzzni/claude-memory-layer/pull/165))
- feat(eval): split grounding report by memory origin (--by-origin) ([#158](https://github.com/buzzni/claude-memory-layer/pull/158))
- feat(hooks): stop injecting the prompt's own session back into it ([#161](https://github.com/buzzni/claude-memory-layer/pull/161))
- feat(hooks): skip the session's own events when SessionStart resumes it ([#163](https://github.com/buzzni/claude-memory-layer/pull/163))
- feat(forget): implement forget --before <date> [--type] as a real retention purge ([#162](https://github.com/buzzni/claude-memory-layer/pull/162))

### Fixed

- fix(session-end): reconcile the transcript into the registered project, not the SessionEnd cwd ([#164](https://github.com/buzzni/claude-memory-layer/pull/164))
- fix(cleanup): classify empty and registry-forgotten temp stores in store cleanup preview ([#160](https://github.com/buzzni/claude-memory-layer/pull/160))

## [2.5.2] - 2026-11-07

### Added

- feat(hooks): measure Stop replies missing from the transcript batch ([#157](https://github.com/buzzni/claude-memory-layer/pull/157))

## [2.5.1] - 2026-11-06

### Security

- fix(mongo-sync): keep connection-string secrets out of connection errors ([#154](https://github.com/buzzni/claude-memory-layer/pull/154))

## [2.5.0] - 2026-11-01

### Added

- feat(mongo-sync): instanceId별 로컬·Mongo 대조 진단 (mongo-sync audit) ([#146](https://github.com/buzzni/claude-memory-layer/pull/146))
- feat(eval): hook-path counterfactual grounding replay (#119), scoring changes deferred (T4) ([#137](https://github.com/buzzni/claude-memory-layer/pull/137))
- feat(claude-session-end): reconcile the transcript once more in a detached worker (T8) ([#135](https://github.com/buzzni/claude-memory-layer/pull/135))
- feat(doctor): --fix repairs the managed embedding backend when safe (T13) ([#127](https://github.com/buzzni/claude-memory-layer/pull/127))
- feat(hooks): opt-in retrieval query sanitizer for long prompts (CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT) ([#125](https://github.com/buzzni/claude-memory-layer/pull/125))
- feat(claude-stop): read the transcript from a per-session cursor (T7) ([#124](https://github.com/buzzni/claude-memory-layer/pull/124))
- feat(mcp): absolute MCP command on install; doctor checks MCP client configs (T12) ([#123](https://github.com/buzzni/claude-memory-layer/pull/123))
- feat(query): opt-in absolute FTS score scale (CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT) ([#121](https://github.com/buzzni/claude-memory-layer/pull/121))
- feat(claude-stop): keep each assistant message's transcript time (authored_at) ([#120](https://github.com/buzzni/claude-memory-layer/pull/120))

### Changed

- chore(eval): provenance block on evaluation results (T16) ([#143](https://github.com/buzzni/claude-memory-layer/pull/143))
- chore(eval): enforce dev/test split for lesson-recall fixtures and host labels (T15) ([#133](https://github.com/buzzni/claude-memory-layer/pull/133))
- refactor(core): unify harness boilerplate detection into one anchored marker list (T9) ([#129](https://github.com/buzzni/claude-memory-layer/pull/129))
- chore(release): guard and auto-sync plugin manifest version ([#118](https://github.com/buzzni/claude-memory-layer/pull/118))

[Unreleased]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.11...HEAD
[2.5.11]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.10...v2.5.11
[2.5.10]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.9...v2.5.10
[2.5.9]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.8...v2.5.9
[2.5.8]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.7...v2.5.8
[2.5.7]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.6...v2.5.7
[2.5.6]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.5...v2.5.6
[2.5.5]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.4...v2.5.5
[2.5.4]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.3...v2.5.4
[2.5.3]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.2...v2.5.3
[2.5.2]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/buzzni/claude-memory-layer/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/buzzni/claude-memory-layer/compare/v2.4.17...v2.5.0
