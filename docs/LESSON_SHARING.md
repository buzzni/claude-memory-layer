# Sharing curated lessons through git

`lesson export` writes chosen lessons into the repository as one JSON file per
lesson. The team reviews and commits those files like code. `lesson import`
reads them into another checkout's local store. Only reviewed lesson text
travels: no events, sessions, or anything about the machine that wrote it.

Use this when a handful of rules ("run the parser fixtures after changing the
grammar") should reach everyone working on the repository. To move whole
histories between servers, use [Mongo sync](MONGO_SYNC.md). It is a different
tool for a different job.

## Commands

Both commands are dry runs until `--apply`. The preview lists every file with
its action, so you see what will be added, changed, or removed before anything
is written.

```bash
# Preview, then write every curated (and previously imported) lesson
claude-memory-layer lesson export -p . --all-curated
claude-memory-layer lesson export -p . --all-curated --apply

# Or pick lessons by local id, exact name, or shared id
claude-memory-layer lesson export -p . --lesson "Release checklist" --lesson 3f2a… --apply

# Preview, then import the committed files into this checkout's store
claude-memory-layer lesson import -p .
claude-memory-layer lesson import -p . --apply
```

| Option | Command | Meaning |
|---|---|---|
| `--lesson <selector...>` | export | Lesson id, exact name, or shared id (the file name without `.json`). Repeatable |
| `--all-curated` | export | Every recall-enabled lesson whose source class is `curated` or `imported` |
| `--prune` | export | Also remove lesson files in the directory that the selection does not include |
| `--dir <path>` | both | Lesson directory, relative to the project. Default `.claude-memory-layer/lessons` |
| `--actor <actor>` | import | Actor recorded in the governance audit. Default `cml-cli` |
| `--apply` | both | Write; omitted means dry run |
| `--json` | both | Machine-readable output |

Export entries have the action `add`, `update`, `unchanged`, or `remove`.
Import entries have `add`, `update`, `unchanged`, `conflict`, or `invalid`, and
`counts` totals them. An import with conflicts or invalid files still applies
its adds and updates. It reports the rest and exits 0, so read `counts` in a
script. All adds and updates go in one transaction.

The default directory is product-named and inside the repository, so the files
are committed with the code. It does not collide with `.claude/`, which belongs
to Claude Code.

## File format

One file per lesson, `<id>.json`. The `id` is the first 16 hex characters of
the SHA-256 of the lesson name. A lesson name is unique within a project, so
the same lesson always lands in the same file, on every machine.

```json
{
  "format": "claude-memory-layer/lesson@1",
  "id": "4c236daafb445f86",
  "name": "Release checklist",
  "trigger": "when a release is requested",
  "steps": [
    "run tests",
    "tag the release"
  ],
  "failureModes": [
    "skipping the check"
  ],
  "validation": [],
  "validVersions": [],
  "confidence": 1,
  "skillCandidate": true
}
```

`scope` and `reconsiderWhen` appear when the lesson has them. Keys are always
written in this order, with two-space indentation and a final newline, so
exporting an unchanged lesson again writes the same bytes. Import rejects
(`invalid`) a file that is not valid JSON, has an unknown field, or whose `id`
does not match its name and file name.

Why one file per lesson rather than one JSONL file: two people adding
different lessons touch different files, so git merges them without a
conflict, and a change to one lesson is a diff of that one file. In a single
sorted JSONL file, two additions next to each other in sort order already
conflict.

### What is not exported

- Local lesson ids, the project hash, and created/updated times. They differ
  per machine, so exporting them would change the file on every export.
- Source session and event ids. They refer to the exporting machine's store.
  The governance audit there still records them.
- Revision, the recall switch, and runbook absorption. These are local state.

### Redaction

Every text field goes through the curated-lesson privacy filter (private tags,
credential patterns) and the audit sanitizer (credential assignments,
absolute POSIX, Windows, and UNC paths). Both run until neither changes the
text. Import runs the same redaction again, for hand-edited files. Entries
whose text changed list it in `redactedFields`. Redaction is pattern-based, so
still read the diff before you commit it.

## Team workflow

1. Alice curates a lesson (`lesson add … --apply`, or through MCP).
2. Alice runs `lesson export -p . --all-curated`, checks the preview, runs it
   again with `--apply`, and opens a PR with the new file under
   `.claude-memory-layer/lessons/`.
3. The team reviews the lesson text in the PR, like any other change.
4. After the merge, Bob pulls and runs `lesson import -p .`, then
   `lesson import -p . --apply`.
5. Bob runs `lesson export --all-curated` later. His imported lessons export
   to the same bytes (`unchanged`), and only his own new lessons appear as
   `add`.

When Alice changes the lesson and the team merges the new file, Bob's next
import shows it as `update`, provided Bob has not changed his copy.

## Imports never overwrite silently

- **New name**: `add`. The lesson is stored with source class `imported`.
- **Same text** (any source class): `unchanged`. Nothing is written, and a
  repeated import is a no-op.
- **Different text, the local lesson was itself imported and nothing changed
  it since**: `update`. "Nothing changed it" means its revision still equals
  the revision recorded by its last `lesson_import` audit entry. The update
  re-checks that revision inside the transaction.
- **Different text, anything else**: `conflict`, with the differing fields. A
  local curated or derived lesson with that name is never replaced. An
  imported lesson that someone edited, switched off, or consolidated locally
  is not replaced either. Resolve it by renaming one side or by bringing the
  file and the local lesson back in line.

Every add and update writes a `lesson_import` row to the governance audit:
actor, before and after snapshots, and the file it came from.

## Trust

An imported lesson's origin is `imported`, read from the stored
`source_class` column. Only `lesson import` writes that value. Lesson save
input cannot set it. Saving an imported lesson again through `lesson add` or
MCP keeps it `imported`, so no caller can raise its trust.

Where lessons are injected automatically, an imported lesson carries the
`[low-trust: imported]` label: in the per-prompt lesson lane, in the
SessionStart lesson index, and in the pre-edit check. The label stays even
though a team reviewed the file in a PR. CML cannot see that review, and the
file is a direct path into every teammate's context: whoever can merge to the
repository can put text there. Same as other `imported` memories, the label
does not keep the lesson out of injection, not even with
`sourceTrust.excludeUntrustedFromAutoInjection`.

Two lanes leave imported lessons out:

- `mem-context-pack` includes only `curated` lessons, as before.
- Host lesson recall (`lesson-host-service`) has no response field for the
  label, so imported lessons stay out of it. An explicit `get` still reads
  them.

## Limits

- **No deletion propagation.** Deleting a file, or `--prune`, does not delete
  the lesson where it was already imported.
- **A rename is a new lesson.** The id comes from the name, so a renamed lesson
  exports to a new file. Without `--prune`, the old file stays.
- **Lessons only.** Core memory blocks are not exported. They have no column
  that could mark an imported block, and SessionStart injects them
  unconditionally without an origin label. Sharing them would need a schema
  change.
- **Explicit commands only.** There is no automatic sync, hook, or MCP tool.
- **Older versions.** A build from before this feature reads an `imported`
  lesson as `derived`, so the label is lost. Its lesson save does not keep the
  source class either.
