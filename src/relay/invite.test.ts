import { describe, expect, it } from 'vitest';

import { LocalStore } from '../storage/local-store.js';
import type { KdfOptions } from '../storage/crypto.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRelayRoomMaterial,
  decryptRelayInvite,
  deriveRelayLocator,
  isRelayInviteCode,
} from './invite.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};

describe('Internet relay invite', () => {
  it('round-trips a compact code and opaque invite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p2pchat-relay-invite-'));
    try {
      const store = await LocalStore.open({
        directory,
        passphrase: 'relay invite unit test passphrase',
        kdfOptions: testKdfOptions,
      });
      const material = createRelayRoomMaterial(store.identity, 60_000);
      const spacedCode = material.code.replaceAll('-', ' \n');
      const locator = deriveRelayLocator(spacedCode);

      expect(material.code).toMatch(
        /^p2pr1-(?:[0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/u,
      );
      expect(isRelayInviteCode(material.code)).toBe(true);
      expect(locator.roomId).toBe(material.roomId);
      expect(
        decryptRelayInvite(locator, material.encryptedInvite),
      ).toMatchObject({ creatorIdentityId: store.identity.id });

      const tampered = `${material.encryptedInvite.slice(0, -1)}A`;
      expect(() => decryptRelayInvite(locator, tampered)).toThrow('invalid');
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
