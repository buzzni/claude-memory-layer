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
| `--prune` | export | Also remove unselected lesson files, but only those that read as valid lesson exports. Check the preview's `remove` list first: a teammate's lesson that is not in your selection is removed too |
| `--dir <path>` | both | Lesson directory, relative to the project. Default `.claude-memory-layer/lessons` |
| `--actor <actor>` | import | Actor recorded in the governance audit. Default `cml-cli` |
| `--apply` | both | Write; omitted means dry run |
| `--json` | both | Machine-readable output |

Export entries have the action `add`, `update`, `unchanged`, `remove`,
`keep` (prune left a file that is not a valid lesson export), or `rejected`
(a file that cannot be written safely). Import entries have `add`, `update`,
`unchanged`, `conflict`, or `invalid`. `counts` totals them.

Exit status:

| Status | Meaning |
|---|---|
| 0 | Every entry was applied, or needed nothing |
| 2 | At least one entry is `conflict`, `invalid`, or `rejected`. The other entries were still applied (with `--apply`) and the output lists all of them |
| 1 | The command failed. Causes: the directory is refused (see below), it is over a limit, or the store changed while importing. An import writes nothing. A refused directory or limit stops either command before it writes. An export that fails partway keeps the files it already wrote |

All adds and updates of one import go in one transaction. Inside it, each
entry is checked again. An add whose name now exists, or an update whose
lesson moved past the planned revision (another import, a local edit), fails
the whole import, so nothing is overwritten and nothing is half done.

The default directory is product-named and inside the repository, so the files
are committed with the code. It does not collide with `.claude/`, which belongs
to Claude Code.

### Symbolic links

A repository can contain symbolic links, and a link would let a cloned
lesson file read or overwrite something outside the directory. So:

- Every component from the project root down to the lesson directory that
  exists must be a real directory, checked with `lstat`. A link anywhere on
  that path, the lesson directory itself included, refuses the whole command
  (exit 1). The project root itself may be a link: you named it. For a
  `--dir` outside the project, only that directory itself is checked.
- Only regular files are read or written. A lesson file that is a link is
  `invalid` on import and `rejected` on export, and its target is never read
  or written. Reads open the file without following links where the platform
  supports it, and check the size on the open file.
- Writes create a new file exclusively in the same directory and rename it
  over the target. The rename replaces the directory entry and never writes
  through a link. The directory path is checked again right before each
  rename. Prune unlinks, and unlinking never follows a link.

Static links committed to the repository are blocked. Nothing is guaranteed
against a local process that can change the directory while the command
runs. Such a process could swap the directory, or one of its parents, for a
link between the check and the open: `O_NOFOLLOW` protects only the last
path component. That needs a process already able to write to the checkout,
and a cloned repository alone cannot do it.

Hard links are regular files to `lstat`, so import reads a hard-linked lesson
file like any other. Git does not store hard links, so one only exists when
something on this machine created it. Export never writes through one: the
rename replaces the directory entry and leaves the other link's file
untouched.

### Size limits

A lesson is a short procedure. `lesson add` takes at most 100 steps, and
recall shows the first 8, so a 100-step lesson with steps of about 600 bytes
is the realistic ceiling. The limits leave room above that and are checked
before any file is read:

| Limit | Value | When it is exceeded |
|---|---|---|
| One lesson file | 64 KiB | Import: that file is `invalid`. Export: that lesson is `rejected`, so export never writes a file that import refuses |
| Lesson files in the directory | 1000 | The whole import is refused (exit 1) |
| All lesson files together | 16 MiB, counting only regular files of 64 KiB or less (an oversized file is reported on its own and not counted) | The whole import is refused (exit 1) |

A shared set beyond these is more than a team can review. It is also more
than the per-prompt lesson lane, which scans every enabled lesson, should
carry.

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
  file and the local lesson back in line. The command exits 2.

Every add and update writes a `lesson_import` row to the governance audit:
actor, before and after snapshots, and the file it came from.

## Trust

An imported lesson's origin is `imported`, read from the stored
`source_class` column. Only `lesson import` writes that value. Lesson save
input cannot set it. Trust only goes down:

- Saving an imported lesson again keeps it `imported`. This covers
  `lesson add`, MCP `mem-lesson-save`, candidate promotion, and a
  host-approved update of that lesson.
- A runbook that absorbs an imported lesson (`lesson consolidate`) is
  `imported` itself. The preview shows each runbook's `sourceClass`.
- The store refuses any `UPDATE` that would move an imported lesson to
  another source class. A trigger on `memory_lessons`
  (`memory_lessons_imported_stays_imported`) enforces this for every update
  this tool's write paths issue. It does not guard against someone who can
  run arbitrary SQL on the database file. `INSERT OR REPLACE`, a delete
  followed by an insert, or a renamed column all bypass it. None of the
  lesson save, import, or consolidate paths issue such SQL.

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
  lesson as `derived`, so the label is lost. If that build saves an imported
  lesson again, the store's trigger rejects the save instead of letting it
  become curated.
- **Copying the text is not tracked.** Provenance follows the stored row, not
  the text. Someone who retypes an imported lesson's text under a new name
  with `lesson add` makes a `curated` lesson. The same holds when that text
  is proposed as a new host candidate and the host approves it: approval
  inserts a new `curated` row.
- **Hard links and live directory swaps.** See [Symbolic links](#symbolic-links).
- **Invalid after redaction.** A file whose text is within the limits but
  grows past them once redacted is `invalid` on import. Export marks such a
  lesson `rejected`. Other files are still processed.
