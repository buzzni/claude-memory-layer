// Compatibility re-export. Endless memory is an optional extension, but existing
// engine/facade imports still resolve through this path during the strangler
// migration.
export * from '../../extensions/endless-memory/index.js';
