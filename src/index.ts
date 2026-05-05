/**
 * Public package entrypoint.
 *
 * Keep this file lightweight: consumers importing `claude-memory-layer` should
 * receive the core/service APIs described by package.json `main` without having
 * to import CLI or hook executables.
 */

export * from './core/index.js';
export * from './services/memory-service.js';
export * from './services/memory-service-config.js';
export * from './services/memory-service-registry.js';
