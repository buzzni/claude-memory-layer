# Mongo Sync (optional, multi-server)

[← README](../README.md)

Mongo sync is optional and off by default. When you develop the same project on several servers, it gathers each server's local SQLite events into one MongoDB database and pushes/pulls between them. It never runs from a hook; it runs only when you start `mongo-sync` yourself, once or continuously with `--watch`.

Before connecting a database, read the "Mongo sync" section of [SECURITY.md](../SECURITY.md): push sends stored events as they are (including fields that are not masked before storage), and pulled events can later be injected into prompts as recalled memory. Treat every principal with write access to that database as inside your trust boundary.

## Usage

```bash
export CLAUDE_MEMORY_MONGO_URI="mongodb://HOST:PORT/"   # add user:password@ if needed; keep it out of committed files
export CLAUDE_MEMORY_MONGO_DB="claude_memory_layer"
export CLAUDE_MEMORY_MONGO_PROJECT="my-project"
claude-memory-layer mongo-sync
claude-memory-layer mongo-sync --watch --interval 30000
claude-memory-layer mongo-sync --watch --interval 30000 --process-after-sync --process-interval 120000
```

| Option | Default | Meaning |
|---|---|---|
| `-p, --project <path>` | cwd | Local project to sync |
| `--mongo-uri <uri>` | `CLAUDE_MEMORY_MONGO_URI` | MongoDB connection URI |
| `--mongo-db <name>` | `CLAUDE_MEMORY_MONGO_DB` | Database name |
| `--mongo-project <key>` | `CLAUDE_MEMORY_MONGO_PROJECT`, else the last folder name of the project path | Remote project key; use the same value on every server |
| `--direction <dir>` | `both` | `push`, `pull` or `both` |
| `--batch-size <n>` | `500` | Batch size |
| `--watch` / `--interval <ms>` | off / `30000` | Run continuously at this interval |
| `--process-after-sync` / `--process-interval <ms>` | off / `120000` | Process pending embeddings after pull activity, at most once per interval |

If you want pulled events to show up in semantic search and context packs right away, add `--process-after-sync`. It runs only when a pull brought in new events, is debounced by `--process-interval` so embeddings are not reprocessed on every tick, and uses the project-scoped `vector-worker.lock`, so it skips when a separate `process` worker is already running.

## Project identity across servers

Project paths may differ between servers. Pulled events are re-attributed to this server's project (the hash of the `--project` path), so they appear in project-scoped search; the original server's project scope and hostname are kept in `metadata.mongoSync`. Every pulled event gets a `metadata.mongoSync` record, so recall labels it as coming from another machine (`low-trust: imported`, see [HOW_IT_WORKS.md](HOW_IT_WORKS.md#source-trust-labels)). To gather one project, set `--mongo-project` (or `CLAUDE_MEMORY_MONGO_PROJECT`) to the same value on every server.

## How the pull cursor works

The pull cursor is kept per pushing store (origin). Each store creates an origin id on its first sync and keeps it in `sync_positions` together with a machine identifier (a hash of the OS machine id); every document it pushes carries a sequence number within that origin (`originSeq`). A pull reads each origin from just after the last `originSeq` it saw and skips its own origin. Reservation and insertion for one origin happen in order under a store-level lock (`mongo-sync-push.lock`), so a document cannot slip in below the cursor even if a push stalls or server clocks disagree. Pulled events are never pushed again.

A store keeps its origin id as long as the stored machine identifier matches the current machine. If a store folder is copied (or restored from backup) onto **another machine**, the identifiers differ, so that machine creates a new origin id and the two stores keep exchanging events. If a backup is restored on the **same machine**, the store keeps its old origin id. Because a pull skips its own origin, documents that this store pushed after the backup was taken are not pulled back into it.

Documents pushed by older versions have no `originSeq`. They are read as before, with a project-wide seq cursor, re-reading documents that arrived from 30 minutes before the previous pull up to the cursor. On that path, clock skew between servers plus push delay must stay under 30 minutes, so upgrading every server is recommended. The first pull on the new version re-reads everything once per project key to fill in documents the old cursor missed (events you already have are skipped).

## Audit

```bash
claude-memory-layer mongo-sync audit
```

Read-only. It compares local events with MongoDB per source instance and reports documents a pull missed. It uses the same `-p/--mongo-uri/--mongo-db/--mongo-project` options as `mongo-sync`.
