import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChatSession, type ChatEvent } from '../chat/session.js';
import { prepareImage } from '../image/image.js';
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
      expect(creatorSession.remoteFeatures).toContain('image-v1');
      expect(joinerSession.remoteFeatures).toContain('image-v1');
      expect(creatorSession.remoteFeatures).not.toContain('video-call-v1');
      expect(joinerSession.remoteFeatures).not.toContain('video-call-v1');

      const creatorChat = new ChatSession(creatorSession, creatorStore);
      const joinerChat = new ChatSession(joinerSession, joinerStore);
      expect(creatorChat.supportsVideoCalls).toBe(false);
      expect(joinerChat.supportsVideoCalls).toBe(false);
      const creatorReceived = Promise.withResolvers<undefined>();
      const joinerDelivered = Promise.withResolvers<undefined>();
      const joinerReplyReceived = Promise.withResolvers<undefined>();
      const creatorReplyDelivered = Promise.withResolvers<undefined>();
      const creatorImageReceived = Promise.withResolvers<undefined>();
      const joinerImageDelivered = Promise.withResolvers<undefined>();
      const creatorEvents: ChatEvent[] = [];
      const joinerEvents: ChatEvent[] = [];
      let creatorReceivedCount = 0;
      let joinerDeliveredCount = 0;
      const creatorLoop = creatorChat.run((event) => {
        creatorEvents.push(event);
        if (event.kind === 'received') {
          creatorReceivedCount += 1;
          if (creatorReceivedCount === 1) {
            creatorReceived.resolve(undefined);
          } else if (creatorReceivedCount === 2) {
            creatorImageReceived.resolve(undefined);
          }
        } else if (event.kind === 'delivered') {
          creatorReplyDelivered.resolve(undefined);
        }
      });
      const joinerLoop = joinerChat.run((event) => {
        joinerEvents.push(event);
        if (event.kind === 'delivered') {
          joinerDeliveredCount += 1;
          if (joinerDeliveredCount === 1) {
            joinerDelivered.resolve(undefined);
          } else if (joinerDeliveredCount === 2) {
            joinerImageDelivered.resolve(undefined);
          }
        } else if (event.kind === 'received') {
          joinerReplyReceived.resolve(undefined);
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

      const replyMessageId = await creatorChat.send(
        'replying to that exact message',
        messageId,
      );
      await Promise.all([
        joinerReplyReceived.promise,
        creatorReplyDelivered.promise,
      ]);
      expect(
        joinerChat.history().find((message) => message.id === replyMessageId),
      ).toEqual(
        expect.objectContaining({
          senderPeerId: creatorStore.identity.id,
          body: 'replying to that exact message',
          replyToMessageId: messageId,
          deliveryState: 'received',
        }),
      );
      expect(
        creatorChat.history().find((message) => message.id === replyMessageId),
      ).toEqual(expect.objectContaining({ deliveryState: 'delivered' }));

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const image = prepareImage(
        Buffer.concat([png, Buffer.alloc(IMAGE_TEST_TRAILING_BYTES, 0x41)]),
        'test-picture.png',
      );
      const imageMessageId = await joinerChat.sendImage(
        image,
        'encrypted picture',
        replyMessageId,
      );
      await Promise.all([
        creatorImageReceived.promise,
        joinerImageDelivered.promise,
      ]);

      const receivedImageMessage = creatorChat
        .history()
        .find((message) => message.id === imageMessageId);
      expect(receivedImageMessage?.body).toBe('encrypted picture');
      expect(receivedImageMessage?.deliveryState).toBe('received');
      expect(receivedImageMessage?.replyToMessageId).toBe(replyMessageId);
      expect(receivedImageMessage?.image?.filename).toBe('test-picture.png');
      expect(receivedImageMessage?.image?.mimeType).toBe('image/png');
      expect(receivedImageMessage?.image?.byteLength).toBe(
        image.bytes.byteLength,
      );
      expect(
        creatorStore.readImageAttachment(receivedImageMessage?.image?.id ?? ''),
      ).toEqual(image.bytes);
      expect(
        joinerChat.history().find((message) => message.id === imageMessageId),
      ).toEqual(expect.objectContaining({ deliveryState: 'delivered' }));

      await Promise.all([creatorChat.close(), joinerChat.close()]);
      await Promise.all([creatorLoop, joinerLoop]);
    } finally {
      await Promise.all([creatorNetwork.stop(), joinerNetwork.stop()]);
      creatorStore.close();
      joinerStore.close();
    }
  }, 20_000);
});

const IMAGE_TEST_TRAILING_BYTES = 30 * 1024;
