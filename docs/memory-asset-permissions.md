# Memory asset permissions

The first permission layer is intentionally project-local and actor-based. It
does not introduce users, teams, sessions, or a second identity provider. It
reuses the existing perspective-memory actor id as its principal.

## Policy order

Permission checks are deterministic and use this order:

1. The asset owner has `read`, `write`, `bind`, and `grant`.
2. `project` and `shared` visibility grant `read` only.
3. An enabled actor binding grants `read` only.
4. An explicit actor grant supplies only its listed permissions.
5. Everything else is denied.

There are no implicit write permissions and no deny ACLs in this phase. An
empty explicit grant replaces the previous set and acts as an auditable
revocation. A disabled binding likewise removes binding-based read access.

`shared` currently means that the asset is eligible for a future shared-store
integration. The MCP handlers still require an absolute project path and open
only that project's SQLite store, so it does not bypass project isolation.

## Storage

- `memory_assets`: owner, lifecycle, visibility, version, and canonical source references
- `memory_asset_bindings`: actor injection mode, priority, and enabled state
- `memory_asset_grants`: full replacement permission set per asset/actor
- `memory_governance_audit`: create, update, bind, and grant/revoke history

Asset content is not copied into the registry. `source_refs_json` points to the
canonical event, lesson, skill, wiki, or code-graph subsystem.

## MCP operations

- `mem-asset-create`
- `mem-asset-get`
- `mem-asset-list`
- `mem-asset-update`
- `mem-asset-bind`
- `mem-asset-grant-set`
- `mem-asset-check`

Every operation requires an absolute `projectPath` and a `requesterActorId`.
Unauthorized `get` calls use the same `found: false` response as missing assets
to avoid disclosing private asset existence. Denied `check` calls likewise use
the same generic decision for missing and inaccessible assets. Updates can include
`expectedVersion` for optimistic concurrency control.

## Follow-up integration order

1. Register existing lessons and core-memory blocks as assets without changing their canonical tables.
2. Gate their read/update handlers through this permission service.
3. Feed enabled bindings into session-start and context-pack injection lanes.
4. Add a cross-project shared-store adapter only after actor identity mapping is explicit.
5. Add teams/roles or deny ACLs only when a concrete multi-user requirement cannot be represented by ownership, visibility, bindings, and explicit grants.
