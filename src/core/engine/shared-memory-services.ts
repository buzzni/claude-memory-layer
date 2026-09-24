// Compatibility re-export. Shared memory is an optional extension, but existing
// engine/facade imports still resolve through this path during the strangler
// migration.
export * from '../../extensions/shared-memory/index.js';
