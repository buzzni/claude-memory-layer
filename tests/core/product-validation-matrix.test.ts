import { describe, expect, it } from 'vitest';

import {
  getProductValidationMatrixSummary,
  productValidationMatrix,
  renderProductValidationMatrixMarkdown
} from '../../src/core/product-validation-matrix.js';

const requiredSurfaces = [
  'claude.adapter.import',
  'claude.adapter.search',
  'claude.adapter.disclosure',
  'codex.adapter.scan',
  'codex.adapter.import',
  'codex.adapter.replay',
  'hermes.adapter.scan',
  'hermes.adapter.import',
  'hermes.adapter.replay',
  'mcp.context.pack',
  'mcp.project.timeline',
  'mcp.source.ref',
  'cli.api.reporting',
  'safety.dryRun'
];

describe('product validation matrix', () => {
  it('covers the product-level validation surfaces with requirements and evidence', () => {
    const surfaceIds = new Set(productValidationMatrix.map((surface) => surface.id));

    for (const id of requiredSurfaces) {
      expect(surfaceIds.has(id), `missing surface ${id}`).toBe(true);
    }

    for (const surface of productValidationMatrix) {
      expect(surface.title).toBeTruthy();
      expect(surface.requirements.length, `${surface.id} requirements`).toBeGreaterThan(0);
      expect(surface.evidence.length, `${surface.id} evidence`).toBeGreaterThan(0);
      expect(['ready', 'covered', 'partial', 'planned']).toContain(surface.status);
    }
  });

  it('summarizes and renders a stable reporting-friendly matrix', () => {
    const summary = getProductValidationMatrixSummary(productValidationMatrix);
    expect(summary.totalSurfaces).toBeGreaterThanOrEqual(requiredSurfaces.length);
    expect(summary.surfacesByArea.codex).toBeGreaterThanOrEqual(3);
    expect(summary.surfacesByArea.hermes).toBeGreaterThanOrEqual(3);
    expect(summary.surfacesByArea.mcp).toBeGreaterThanOrEqual(3);
    expect(summary.surfacesByArea.claude).toBeGreaterThanOrEqual(3);
    expect(summary.evidenceCount).toBeGreaterThanOrEqual(requiredSurfaces.length);

    const markdown = renderProductValidationMatrixMarkdown(productValidationMatrix);
    expect(markdown).toContain('# Product Validation Matrix');
    expect(markdown).toContain('Codex adapter replay');
    expect(markdown).toContain('Hermes adapter replay');
    expect(markdown).toContain('MCP context pack');
    expect(markdown).toContain('MCP source reference');
    expect(markdown).toContain('Safety / dry-run');
    expect(markdown).toContain('tests/core/codex-session-history-importer-validation.test.ts');
    expect(markdown).toContain('tests/core/hermes-session-history-importer-validation.test.ts');
  });

  it('documents context-pack budget controls and the MCP-only CLI/API parity boundary', () => {
    const contextPackSurface = productValidationMatrix.find((surface) => surface.id === 'mcp.context.pack');
    expect(contextPackSurface).toBeDefined();

    const searchableText = [
      ...(contextPackSurface?.requirements ?? []),
      ...(contextPackSurface?.evidence.map((item) => item.note) ?? [])
    ].join('\n');

    expect(searchableText).toContain('maxChars');
    expect(searchableText).toContain('maxTokens');
    expect(searchableText).toContain('compression');
    expect(searchableText).toContain('MCP-only');
    expect(searchableText).toContain('CLI/API parity');
  });
});
