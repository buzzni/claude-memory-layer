/**
 * Tests for canonical key functions
 */

import { describe, it, expect } from 'vitest';
import {
  makeCanonicalKey,
  isSameCanonicalKey,
  makeDedupeKey,
  hashContent
} from '../src/core/canonical-key.js';

describe('makeCanonicalKey', () => {
  it('should normalize to lowercase', () => {
    expect(makeCanonicalKey('Hello World')).toBe('hello world');
  });

  it('should remove punctuation', () => {
    expect(makeCanonicalKey('Hello, World!')).toBe('hello world');
  });

  it('should normalize unicode (NFKC)', () => {
    // Full-width characters should be normalized
    expect(makeCanonicalKey('Ｈｅｌｌｏ')).toBe('hello');
  });

  it('should collapse whitespace', () => {
    expect(makeCanonicalKey('hello   world')).toBe('hello world');
    expect(makeCanonicalKey('hello\n\nworld')).toBe('hello world');
    expect(makeCanonicalKey('  hello  world  ')).toBe('hello world');
  });

  it('should add project context when provided', () => {
    const key = makeCanonicalKey('test', { project: 'myproject' });
    expect(key).toBe('myproject::test');
  });

  it('should truncate long keys with MD5 suffix', () => {
    const longTitle = 'a'.repeat(300);
    const key = makeCanonicalKey(longTitle);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/_[a-f0-9]{8}$/);
  });
});

describe('isSameCanonicalKey', () => {
  it('should return true for equivalent strings', () => {
    expect(isSameCanonicalKey('Hello World', 'hello world')).toBe(true);
    expect(isSameCanonicalKey('Hello, World!', 'hello world')).toBe(true);
    expect(isSameCanonicalKey('  hello   world  ', 'hello world')).toBe(true);
  });

  it('should return false for different strings', () => {
    expect(isSameCanonicalKey('hello', 'world')).toBe(false);
    expect(isSameCanonicalKey('hello world', 'world hello')).toBe(false);
  });
});

describe('makeDedupeKey', () => {
  it('should create unique keys for different content', () => {
    const key1 = makeDedupeKey('content1', 'session1');
    const key2 = makeDedupeKey('content2', 'session1');
    expect(key1).not.toBe(key2);
  });

  it('should create unique keys for different sessions', () => {
    const key1 = makeDedupeKey('content', 'session1');
    const key2 = makeDedupeKey('content', 'session2');
    expect(key1).not.toBe(key2);
  });

  it('should create same key for same content and session', () => {
    const key1 = makeDedupeKey('content', 'session');
    const key2 = makeDedupeKey('content', 'session');
    expect(key1).toBe(key2);
  });

  it('should include session ID prefix', () => {
    const key = makeDedupeKey('content', 'session123');
    expect(key.startsWith('session123:')).toBe(true);
  });
});

describe('hashContent', () => {
  it('should return consistent hash', () => {
    const hash1 = hashContent('test content');
    const hash2 = hashContent('test content');
    expect(hash1).toBe(hash2);
  });

  it('should return different hash for different content', () => {
    const hash1 = hashContent('content1');
    const hash2 = hashContent('content2');
    expect(hash1).not.toBe(hash2);
  });

  it('should return 64-character hex string (SHA-256)', () => {
    const hash = hashContent('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
