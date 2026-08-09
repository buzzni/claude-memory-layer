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

## Binding-driven injection

Canonical content is injected only through an enabled actor binding once
enforcement is active. Read visibility or a read grant alone does not cause
automatic injection. The shared selector is used by core-memory SessionStart,
curated-lesson prompt retrieval, and MCP context packs.

Hooks use `actor_id` when the host provides it, otherwise the server-owned
`CLAUDE_MEMORY_ACTOR_ID`. Context-pack callers pass `requesterActorId`. In
`registered` and `strict` modes, a missing actor fails closed: hooks inject no
canonical content and context-pack reports that `requesterActorId` is required.

- `direct`: inject the full canonical block or lesson.
- `summary`: inject a bounded core-memory summary or the lesson trigger and first two steps.
- `reference`: inject only a reference hint; it never includes canonical body text.
- `tool`: never auto-inject; it remains available for an explicit tool lookup.

In `registered` mode, unregistered records retain legacy injection while a
valid registered record needs an enabled binding. In `strict`, only valid,
enabled bindings inject. Binding priority orders selected registered assets;
legacy output order remains unchanged.

## Actor-scoped shared troubleshooting search

The first cross-project adapter is intentionally limited to the existing
verified troubleshooting store. It is opt-in and does not change legacy
`includeShared` retrieval, canonical asset lookup, or automatic injection.

Before `mem-shared-search` can return an entry, the requester must link its
project-local actor id in every participating project to the same opaque shared
principal id:

1. Call `mem-shared-actor-link` with an absolute `projectPath`,
   `requesterActorId`, and `sharedPrincipalId` in project A.
2. Repeat it in project B with the same `sharedPrincipalId` only when the two
   local actors represent the same principal.
3. Call `mem-shared-search` from either linked project. Results are restricted
   to entries whose `sourceProjectHash` belongs to that principal's linked
   project set.

`mem-shared-actor-status` shows whether the current local actor is linked, and
`mem-shared-actor-unlink` removes only that project/actor mapping. An unlinked
actor gets `linked: false` and an empty result; it never falls back to the
unscoped shared-store search. Relinking the same local actor replaces its old
principal, so the prior principal immediately loses that project's entries.

The mapping is a local shared-store membership record, not an external identity
provider or a grant to canonical memory assets. In particular, it cannot make a
private lesson/core-memory block readable, bindable, or injectable across
projects.

## Shared canonical asset reads

`mem-shared-asset-get` is a read-only, explicit lookup for one source project's
canonical lesson or core-memory block. It requires both `sourceProjectPath` and
`sourceActorId`; the source actor must be linked to the same shared principal
as the requester. The caller cannot obtain content by merely knowing a project
path or an asset id.

The adapter then opens the source project's SQLite database read-only and fails
closed unless all of these conditions hold at lookup time:

1. The source asset has the deterministic canonical registration for the
   requested lesson/block.
2. Its lifecycle status is `active` and its visibility is `shared`.
3. The named source actor has `read` access under the source project's asset
   policy.
4. The referenced canonical lesson/block still exists in that same project.

The response intentionally does not perform an automatic bind or injection.
`private`, `project`, inactive, conflicting, missing, or unlinked assets return
the same `found: false` shape, preventing source asset existence disclosure.

## Follow-up integration order

1. Add teams/roles or deny ACLs only when a concrete multi-user requirement
   cannot be represented by ownership, visibility, bindings, and explicit
   grants.
