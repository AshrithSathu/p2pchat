import { describe, expect, it } from 'vitest';

import { validateNewPassphrase } from './passphrase.js';

describe('validateNewPassphrase', () => {
  it('requires a meaningful local passphrase', () => {
    expect(validateNewPassphrase('too-short')).toBe(
      'Use at least 12 characters.',
    );
    expect(validateNewPassphrase('correct horse battery staple')).toBeNull();
  });
});
