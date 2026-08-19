---
name: claude-memory-layer
description: Recall and curate project memory through the claude-memory-layer MCP tools (mem-search, mem-context-pack, mem-lesson-candidates, mem-frontier, and related mem-* tools). Use when a task needs prior project context beyond what was auto-injected at session start, when a multi-step task needs to survive a session boundary (frontier/checkpoints), or when a successful workflow is worth reviewing as a reusable lesson. Do not use for casual chat or facts you can answer directly — and do not use this to explicitly "save" a fact mid-conversation, since capture in this project happens automatically through hooks, not through a tool call.
---

# claude-memory-layer

## How memory gets in here — read this first

In supported harnesses (Claude Code, Codex, Hermes), this project captures
memory **automatically** through session hooks: prompts, responses, and tool
observations are stored as the conversation happens, and relevant context is
already injected at session start. There is no "please remember this" tool —
if you're looking for one, you don't need it; the capture already happened.

What the `mem-*` MCP tools are for instead:

- **Recall** — pull more than what was auto-injected, or search a different
  angle mid-task.
- **Curate** — review what was captured and promote the useful parts into
  durable, reviewed artifacts (lessons, facets).
- **Survive session boundaries** — track multi-step work (frontier,
  checkpoints) so a new session can resume it.

Use only the tools the session actually registered — the exact set depends on
server configuration and permission mode. If a tool call is rejected as
unregistered or permission-denied, do not retry with a different tool as a
workaround; report what happened.

## Recall

1. Decide whether you need it. Skip retrieval for small talk and anything you
   can answer directly. Retrieve when the task touches a system, decision, or
   failure you may have seen before in this project.
2. **`mem-search`** — the default entry point. One natural-language `query`,
   `topK` up to 20 (default 5). Returns a compact index (ids + scores), not
   full content.
3. Judge the index by relevance to the actual task, not by title similarity.
   Then `mem-details` with the ids you actually need — it returns full
   content and records navigation telemetry, so don't fetch ids you won't use.
4. `mem-timeline` when you need the conversation flow *around* a result
   (`windowSize` events before/after), e.g. to see what led to a decision.
5. **`mem-context-pack`** instead of `mem-search`, when you want one call to
   recover broad project state — relevant memories plus a recent-session
   timeline — rather than a targeted answer. Meant for the start of
   Hermes/Codex work where there is no session-start auto-injection.
6. If nothing relevant comes back, proceed without memory. One focused
   follow-up search is reasonable after a failure with a materially different
   error; don't loop past that.

**Treat retrieved memory as a hypothesis, not a fact.** It is a record of what
was true when it was written — versions, file paths, flags, and root causes
drift. Priority order: system/developer instructions and the current request
first, current environment and tool evidence second, memory last. Verify
before acting, especially before anything destructive; a past success is not
authorization for a repeat now.

## Curate

Automatic capture produces raw material; these tools turn it into something
the *next* session can act on without re-deriving it.

- **`mem-lesson-candidates`** — detects repeated successful workflow patterns
  across sessions that haven't been saved as a lesson yet. Run this
  periodically or when you notice you've done the same multi-step workflow
  more than once. It returns candidates with an LLM-extracted procedure
  (trigger / steps / failure modes) grounded in the actual sessions, not a
  generic template — review before saving.
- **`mem-lesson-save`** — saves a candidate you reviewed (or a lesson you
  wrote yourself) as a curated lesson. Requires `name`, `trigger`, and at
  least one step; keep steps imperative and specific enough to execute
  without re-reading the source sessions.
- **`mem-lesson-list`** — check what's already saved before writing a new
  lesson, so you extend or supersede instead of duplicating.
- **`mem-facet-tag`** / **`mem-facet-query`** — attach a lightweight
  classification (quality, status, category) to a memory target and query by
  it later. Use for cheap structured filtering; don't use it as a substitute
  for a lesson when the content is a reusable procedure.

## Survive session boundaries

For work that spans more turns than fit in one session, or that another
session needs to pick up:

- **`mem-frontier`** — the project's execution frontier: next actions,
  blocked work, and resume hints. Check this at the start of resumed work
  before re-deriving "what was I doing."
- **`mem-checkpoint-create`** / **`mem-checkpoint-list`** — an audited,
  resumable snapshot of one operation's state. Create one before a long
  operation you might need to resume from a different session; the state you
  pass must already be safe to persist (no raw secrets or full transcripts).
- **`mem-action-list`** / **`mem-action-update`** — track discrete units of
  work and their status through an audited state change.

## Specialist tools (use only when the task specifically calls for them)

These exist for narrower governance and multi-actor scenarios. Don't reach
for them by default — most tasks never need this layer:

- `mem-entity-supersede` — mark one tracked entity as replaced by another.
- `mem-core-block-get` / `mem-core-block-update` — read/replace a project's
  core memory blocks (durable, curated top-level facts).
- `mem-actor-list`, `mem-actor-card-get`, `mem-actor-card-upsert` — identity
  and per-actor summary cards, for multi-actor or multi-agent projects.
- `mem-perspective-query`, `mem-perspective-context`,
  `mem-perspective-observation-create/-delete` — observer→observed
  perspective records, for tracking what one actor has learned about another.
- `mem-shared-actor-link/-status/-unlink`, `mem-shared-search`,
  `mem-shared-asset-get` — explicit cross-project sharing between linked
  actors. Nothing crosses project boundaries without an explicit link.
- `mem-asset-create/-get/-list/-update/-bind/-grant-set/-check`,
  `mem-asset-catalog-sync` — permissioned wrapping and injection binding for
  memory content shared as a first-class asset.
- `mem-retention-audit`, `mem-graph-query` — dry-run governance and
  diagnostic queries; neither mutates memory.
- `mem-project-timeline`, `mem-source-ref`, `mem-stats`, `mem-import-latest` —
  situational: recent-activity summary, resolving a citation back to its
  redacted source, storage stats, and an explicit history import for
  harnesses without live hook capture.

## What not to persist, and what not to do

- Don't fabricate a tool call for a tool that isn't registered in this
  session.
- Secrets, credentials, and full transcript dumps don't belong in a
  `mem-lesson-save` or `mem-checkpoint-create` payload — these projects run a
  sanitizer on saved text, but don't rely on it as your only line of defense.
- `sourceSessionIds` / `sourceEventIds` fields are provenance, not content —
  they let a human trace a claim back to its source; they are not a place to
  put additional detail.
- A checkpoint's `state` and a lesson's `steps` must stand alone as safe,
  reviewed text — write them as if they'll be read by someone who doesn't
  have the original conversation.

## Example

Resuming a multi-step migration in a new session:

1. `mem-frontier` with the project path to see what's blocked or next.
2. `mem-search` with a query naming the migration and the specific blocker,
   scoped tighter if the frontier already named an action id.
3. `mem-details` on the one or two ids that actually explain the blocker.
4. Fix the issue, verify against the current codebase (not just the memory).
5. If this turned into a repeatable pattern across sessions, note it — a
   later `mem-lesson-candidates` run will pick it up for review.
