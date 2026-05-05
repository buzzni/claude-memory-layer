/**
 * Core module exports
 * AXIOMMIND Memory Graduation Pipeline
 */

// Types
export * from './types.js';
export * from './model/raw-event.js';
export * from './model/memory-fact.js';
export * from './model/memory-summary.js';
export * from './model/memory-rule.js';
export * from './model/retrieval-result.js';

// Registry
export * from './registry/project-path.js';
export * from './registry/session-registry.js';

// Engine
export * from './engine/index.js';

// Derivation
export * from './derive/index.js';

// Canonical Key (identity)
export * from './canonical-key.js';

// Storage
export * from './event-store.js';
export * from './sqlite-wrapper.js';
export * from './sqlite-event-store.js';
export * from './sync-worker.js';
export * from './mongo-sync-worker.js';
export * from './entity-repo.js';
export * from './edge-repo.js';

// Vector
export * from './vector-store.js';
export * from './embedder.js';
export * from './vector-worker.js';
export * from './vector-outbox.js';

// Product validation
export * from './product-validation-matrix.js';

// Matching & Alignment
export * from './matcher.js';
export * from './evidence-aligner.js';

// Retrieval & Graduation
export * from './retriever.js';
export * from './graduation.js';
export * from './graduation-worker.js';

// Task Entity System
export * from './task/index.js';

// Shared Store (Cross-Project Knowledge)
export * from './shared-event-store.js';
export * from './shared-store.js';
export * from './shared-vector-store.js';
export * from './shared-promoter.js';
