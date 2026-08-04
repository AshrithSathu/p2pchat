import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { KdfOptions } from '../storage/crypto.js';
import { LocalStore } from '../storage/local-store.js';
import { RelayService } from './service.js';

const LIVE_RELAY_ENDPOINT = 'https://p2pchat-relay.sathuashrith.com';
const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};
const directories: string[] = [];
const runLiveTest = process.env['P2PCHAT_LIVE_RELAY_TEST'] === '1';

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe.skipIf(!runLiveTest)('deployed Internet relay', () => {
  it('connects two ratcheted clients and relays only ciphertext', async () => {
    const creatorStore = await createStore('creator');
    const joinerStore = await createStore('joiner');
    const creatorRelay = new RelayService(creatorStore, {
      endpoint: LIVE_RELAY_ENDPOINT,
    });
    const joinerRelay = new RelayService(joinerStore, {
      endpoint: LIVE_RELAY_ENDPOINT,
    });

    try {
      const invitation = await creatorRelay.createInvite(60_000);
      const [creatorSession, joinerSession] = await Promise.all([
        invitation.connected,
        joinerRelay.join(invitation.code),
      ]);
      expect(creatorSession.safetyNumber).toBe(joinerSession.safetyNumber);
      expect(creatorSession.peer.id).toBe(joinerStore.identity.id);
      expect(joinerSession.peer.id).toBe(creatorStore.identity.id);

      const messageSchema = z.object({
        type: z.literal('live-relay-test'),
        body: z.string(),
      });
      await joinerSession.channel.write({
        type: 'live-relay-test',
        body: 'PQXDH + Double Ratchet over the production relay',
      });
      await expect(
        creatorSession.channel.read(messageSchema, AbortSignal.timeout(15_000)),
      ).resolves.toEqual({
        type: 'live-relay-test',
        body: 'PQXDH + Double Ratchet over the production relay',
      });

      await Promise.allSettled([
        creatorSession.channel.close(),
        joinerSession.channel.close(),
      ]);
    } finally {
      creatorRelay.stop();
      joinerRelay.stop();
      creatorStore.close();
      joinerStore.close();
    }
  }, 45_000);
});

async function createStore(label: string): Promise<LocalStore> {
  const directory = await mkdtemp(
    join(tmpdir(), `p2pchat-live-relay-${label}-`),
  );
  directories.push(directory);
  return await LocalStore.open({
    directory,
    passphrase: `${label} live relay test passphrase`,
    kdfOptions: testKdfOptions,
  });
}
