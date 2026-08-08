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

## Canonical catalog registration

`mem-asset-catalog-sync` bridges existing project lessons and core-memory
blocks into the permission registry without moving or copying their content.
It is preview-only by default. Passing `apply: true` creates only missing
assets as `private`, with `requesterActorId` as owner.

Deterministic ids keep reruns idempotent:

- `lesson:<lessonId>`
- `core_memory_block:<project|user>`

Each registered asset stores only that canonical id in `sourceRefs`. Evidence
event ids and core-memory text remain exclusively in their canonical tables.
If a deterministic id is already used for a different source, sync reports a
conflict and does not overwrite it.

## Canonical handler enforcement

Lesson list/save and core-memory get/update handlers read the server-owned
`CLAUDE_MEMORY_ASSET_PERMISSION_MODE` setting. Callers cannot select or
downgrade this mode in an MCP request.

- `legacy` (default): preserve existing behavior while catalog registration is rolled out.
- `registered`: require `requesterActorId`; enforce permissions for validly registered assets and retain legacy access only for records that have not been registered yet.
- `strict`: require `requesterActorId`; deny access to unregistered records as well as registered records without the requested permission.

An invalid setting fails closed with a configuration error instead of falling
back to `legacy`. Deterministic-id conflicts are denied in both enforcement
modes. Read handlers omit inaccessible records, while write handlers return a
generic permission denial. In enforcement modes, the write audit `actor` must
match `requesterActorId` so callers cannot attribute an authorized mutation to
another principal. New lessons cannot be created in `strict` mode;
create and catalog them before the final mode transition.

A staged migration is therefore:

1. Keep `legacy`, run `mem-asset-catalog-sync` in preview mode, resolve conflicts, then apply.
2. Restart the MCP server with `registered` and make clients pass `requesterActorId`.
3. Register any records created during migration, verify grants/bindings, then restart with `strict`.

## Follow-up integration order

1. Feed enabled bindings into session-start and context-pack injection lanes.
2. Add a cross-project shared-store adapter only after actor identity mapping is explicit.
3. Add teams/roles or deny ACLs only when a concrete multi-user requirement cannot be represented by ownership, visibility, bindings, and explicit grants.
