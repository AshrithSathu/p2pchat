import { describe, expect, it } from 'vitest';

import { normalizeProfileName } from './profile.js';

describe('normalizeProfileName', () => {
  it('creates a canonical filesystem-safe profile key', () => {
    expect(normalizeProfileName('  Alice_DEV-2 ')).toBe('alice_dev-2');
  });

  it('rejects traversal, separators, spaces, and oversized names', () => {
    expect(() => normalizeProfileName('../alice')).toThrow('Profile name');
    expect(() => normalizeProfileName('alice/bob')).toThrow('Profile name');
    expect(() => normalizeProfileName('alice bob')).toThrow('Profile name');
    expect(() => normalizeProfileName('a'.repeat(33))).toThrow('Profile name');
  });
});
