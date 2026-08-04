import { describe, expect, it } from 'vitest';

import {
  decryptRecord,
  deriveEncryptionKey,
  encryptRecord,
  type KdfOptions,
} from './crypto.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};

describe('encrypted records', () => {
  it('round-trips with authenticated context', async () => {
    const key = await deriveEncryptionKey(
      'a sufficiently long passphrase',
      Buffer.alloc(16, 7),
      testKdfOptions,
    );
    const encrypted = encryptRecord(
      Buffer.from('private message'),
      key,
      'message:42',
    );

    expect(decryptRecord(encrypted, key, 'message:42').toString('utf8')).toBe(
      'private message',
    );
    expect(() => decryptRecord(encrypted, key, 'message:43')).toThrow();
    key.fill(0);
  });
});
