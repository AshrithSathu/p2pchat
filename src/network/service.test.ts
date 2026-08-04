import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChatSession, type ChatEvent } from '../chat/session.js';
import type { KdfOptions } from '../storage/crypto.js';
import { LocalStore } from '../storage/local-store.js';
import { P2PService } from './service.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};

const directories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `p2pchat-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('P2PService', () => {
  it('authenticates peers and delivers acknowledged chat messages', async () => {
    const creatorStore = await LocalStore.open({
      directory: await temporaryDirectory('creator'),
      passphrase: 'creator local test passphrase',
      kdfOptions: testKdfOptions,
    });
    const joinerStore = await LocalStore.open({
      directory: await temporaryDirectory('joiner'),
      passphrase: 'joiner local test passphrase',
      kdfOptions: testKdfOptions,
    });
    const creatorNetwork = await P2PService.start(creatorStore, {
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    });
    const joinerNetwork = await P2PService.start(joinerStore, {
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    });

    try {
      const invitation = creatorNetwork.createInvite(60_000);
      const [creatorSession, joinerSession] = await Promise.all([
        invitation.connected,
        joinerNetwork.join(invitation.code),
      ]);

      expect(creatorSession.peer.id).toBe(joinerStore.identity.id);
      expect(joinerSession.peer.id).toBe(creatorStore.identity.id);
      expect(creatorSession.safetyNumber).toBe(joinerSession.safetyNumber);
      expect(creatorSession.direction).toBe('creator');
      expect(joinerSession.direction).toBe('joiner');

      const creatorChat = new ChatSession(creatorSession, creatorStore);
      const joinerChat = new ChatSession(joinerSession, joinerStore);
      const creatorReceived = Promise.withResolvers<undefined>();
      const joinerDelivered = Promise.withResolvers<undefined>();
      const creatorEvents: ChatEvent[] = [];
      const joinerEvents: ChatEvent[] = [];
      const creatorLoop = creatorChat.run((event) => {
        creatorEvents.push(event);
        if (event.kind === 'received') {
          creatorReceived.resolve(undefined);
        }
      });
      const joinerLoop = joinerChat.run((event) => {
        joinerEvents.push(event);
        if (event.kind === 'delivered') {
          joinerDelivered.resolve(undefined);
        }
      });

      const messageId = await joinerChat.send('hello from the joiner 👋');
      await Promise.all([creatorReceived.promise, joinerDelivered.promise]);

      expect(creatorChat.history()).toEqual([
        expect.objectContaining({
          id: messageId,
          senderPeerId: joinerStore.identity.id,
          body: 'hello from the joiner 👋',
          deliveryState: 'received',
        }),
      ]);
      expect(joinerChat.history()).toEqual([
        expect.objectContaining({
          id: messageId,
          senderPeerId: joinerStore.identity.id,
          body: 'hello from the joiner 👋',
          deliveryState: 'delivered',
        }),
      ]);
      expect(creatorEvents).toContainEqual({ kind: 'received', messageId });
      expect(joinerEvents).toContainEqual({ kind: 'delivered', messageId });

      await Promise.all([creatorChat.close(), joinerChat.close()]);
      await Promise.all([creatorLoop, joinerLoop]);
    } finally {
      await Promise.all([creatorNetwork.stop(), joinerNetwork.stop()]);
      creatorStore.close();
      joinerStore.close();
    }
  }, 20_000);
});
