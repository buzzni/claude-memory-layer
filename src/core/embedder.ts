// Compatibility re-export. Embedding is an optional vector extension, but
// existing core/engine imports still resolve through this path during the
// strangler migration.
export * from '../extensions/vector/index.js';
