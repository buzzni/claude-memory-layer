/**
 * Pins what every exported schema in core/types.ts fills in for an absent or empty input. zod 4 changed
 * `.default({})` on objects to return `{}` as-is instead of parsing it, which would silently drop every nested
 * default (feature flags, limits) without a type error — this snapshot was recorded on zod 3.
 */

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import * as types from '../../src/core/types.js';

function isSchema(value: unknown): value is ZodType {
  return typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

describe('core/types schema defaults', () => {
  it('fills the same defaults for undefined and {} inputs', () => {
    const filled: Record<string, { fromUndefined?: unknown; fromEmpty?: unknown }> = {};
    for (const [name, value] of Object.entries(types).sort(([a], [b]) => a.localeCompare(b))) {
      if (!isSchema(value)) continue;
      const fromUndefined = value.safeParse(undefined);
      const fromEmpty = value.safeParse({});
      if (!fromUndefined.success && !fromEmpty.success) continue;
      filled[name] = {
        ...(fromUndefined.success ? { fromUndefined: fromUndefined.data } : {}),
        ...(fromEmpty.success ? { fromEmpty: fromEmpty.data } : {})
      };
    }
    expect(Object.keys(filled).length).toBeGreaterThan(0);
    expect(filled).toMatchSnapshot();
  });
});
