import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareImage } from '../image/image.js';
import type { KdfOptions } from './crypto.js';
import { InvalidPassphraseError, LocalStore } from './local-store.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};
const STORAGE_TEST_TIMEOUT_MS = 20_000;

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'p2pchat-test-'));
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

describe('LocalStore', () => {
  it('binds each database to one normalized local profile', async () => {
    const directory = await temporaryDirectory();
    const passphrase = 'alice profile database passphrase';
    const alice = await LocalStore.open({
      directory,
      passphrase,
      profileName: 'Alice',
      kdfOptions: testKdfOptions,
    });
    expect(alice.profileName).toBe('alice');
    alice.close();

    const reopened = await LocalStore.open({
      directory,
      passphrase,
      profileName: 'alice',
      kdfOptions: testKdfOptions,
    });
    expect(reopened.profileName).toBe('alice');
    reopened.close();

    await expect(
      LocalStore.open({
        directory,
        passphrase,
        profileName: 'bob',
        kdfOptions: testKdfOptions,
      }),
    ).rejects.toThrow('belongs to "alice"');
  });

  it('persists one encrypted signing identity', async () => {
    const directory = await temporaryDirectory();
    const first = await LocalStore.open({
      directory,
      passphrase: 'correct horse battery staple',
      kdfOptions: testKdfOptions,
    });
    const identity = first.identity;
    const payload = Buffer.from('authenticate this session');
    const signature = first.sign(payload);

    expect(first.verify(identity.publicKey, payload, signature)).toBe(true);
    first.close();

    const reopened = await LocalStore.open({
      directory,
      passphrase: 'correct horse battery staple',
      kdfOptions: testKdfOptions,
    });
    expect(reopened.identity.id).toBe(identity.id);
    reopened.close();
  });

  it('rejects an incorrect passphrase', async () => {
    const directory = await temporaryDirectory();
    const store = await LocalStore.open({
      directory,
      passphrase: 'correct horse battery staple',
      kdfOptions: testKdfOptions,
    });
    store.close();

    await expect(
      LocalStore.open({
        directory,
        passphrase: 'definitely the wrong passphrase',
        kdfOptions: testKdfOptions,
      }),
    ).rejects.toBeInstanceOf(InvalidPassphraseError);
  });

  it(
    'persists message history without storing plaintext bodies',
    async () => {
      const directory = await temporaryDirectory();
      const peerDirectory = await temporaryDirectory();
      const passphrase = 'history encryption test passphrase';
      const store = await LocalStore.open({
        directory,
        passphrase,
        kdfOptions: testKdfOptions,
      });
      const peerStore = await LocalStore.open({
        directory: peerDirectory,
        passphrase: 'remote peer test passphrase',
        kdfOptions: testKdfOptions,
      });
      const peer = peerStore.identity;
      const conversationId = store.ensureConversation(peer);
      const messageId = randomUUID();
      const secretBody = 'uniquely secret local message body 9417';
      const sentAt = new Date().toISOString();

      store.saveOutgoingMessage({
        conversationId,
        messageId,
        sequenceNumber: store.nextSequenceNumber(conversationId),
        body: secretBody,
        sentAt,
      });
      store.markMessageDelivered(messageId, new Date().toISOString());
      store.close();
      peerStore.close();

      const databaseBytes = await readFile(join(directory, 'chat.db'));
      expect(databaseBytes.includes(Buffer.from(secretBody))).toBe(false);

      const reopened = await LocalStore.open({
        directory,
        passphrase,
        kdfOptions: testKdfOptions,
      });
      expect(reopened.listMessages(conversationId)).toEqual([
        expect.objectContaining({
          id: messageId,
          body: secretBody,
          deliveryState: 'delivered',
        }),
      ]);
      reopened.close();
    },
    STORAGE_TEST_TIMEOUT_MS,
  );

  it(
    'encrypts reply relationships and keeps them conversation-scoped',
    async () => {
      const directory = await temporaryDirectory();
      const firstPeerDirectory = await temporaryDirectory();
      const secondPeerDirectory = await temporaryDirectory();
      const passphrase = 'reply encryption test passphrase';
      const store = await LocalStore.open({
        directory,
        passphrase,
        kdfOptions: testKdfOptions,
      });
      const firstPeer = await LocalStore.open({
        directory: firstPeerDirectory,
        passphrase: 'first reply peer passphrase',
        kdfOptions: testKdfOptions,
      });
      const secondPeer = await LocalStore.open({
        directory: secondPeerDirectory,
        passphrase: 'second reply peer passphrase',
        kdfOptions: testKdfOptions,
      });
      const conversationId = store.ensureConversation(firstPeer.identity);
      const otherConversationId = store.ensureConversation(secondPeer.identity);
      const targetMessageId = randomUUID();
      const replyMessageId = randomUUID();

      store.saveOutgoingMessage({
        conversationId,
        messageId: targetMessageId,
        sequenceNumber: store.nextSequenceNumber(conversationId),
        body: 'original encrypted message',
        sentAt: new Date().toISOString(),
      });
      store.saveOutgoingMessage({
        conversationId,
        messageId: replyMessageId,
        sequenceNumber: store.nextSequenceNumber(conversationId),
        body: 'encrypted specific reply',
        sentAt: new Date().toISOString(),
        replyToMessageId: targetMessageId,
      });
      expect(
        store.getMessage(conversationId, replyMessageId)?.replyToMessageId,
      ).toBe(targetMessageId);
      expect(() =>
        store.saveOutgoingMessage({
          conversationId: otherConversationId,
          messageId: randomUUID(),
          sequenceNumber: store.nextSequenceNumber(otherConversationId),
          body: 'invalid cross-conversation reply',
          sentAt: new Date().toISOString(),
          replyToMessageId: targetMessageId,
        }),
      ).toThrow('Reply target is not part of this conversation');

      store.close();
      firstPeer.close();
      secondPeer.close();

      const rawDatabase = new Database(join(directory, 'chat.db'), {
        readonly: true,
      });
      const row = rawDatabase
        .prepare(
          'SELECT reply_to_ciphertext FROM messages WHERE message_id = ?',
        )
        .get(replyMessageId) as
        { readonly reply_to_ciphertext: Buffer } | undefined;
      rawDatabase.close();
      expect(row).toBeDefined();
      expect(row?.reply_to_ciphertext).toBeInstanceOf(Buffer);
      expect(
        row?.reply_to_ciphertext.equals(Buffer.from(targetMessageId)),
      ).toBe(false);

      const reopened = await LocalStore.open({
        directory,
        passphrase,
        kdfOptions: testKdfOptions,
      });
      expect(reopened.getMessage(conversationId, replyMessageId)).toEqual(
        expect.objectContaining({
          body: 'encrypted specific reply',
          replyToMessageId: targetMessageId,
        }),
      );
      reopened.close();
    },
    STORAGE_TEST_TIMEOUT_MS,
  );

  it('persists encrypted protocol state and supports secure deletion', async () => {
    const directory = await temporaryDirectory();
    const passphrase = 'protocol state encryption test passphrase';
    const secretState = Buffer.from(
      'private ratchet state that must never appear in SQLite plaintext',
    );
    const store = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });

    store.writeSecureState('signal-session', 'peer-1', secretState);
    expect(store.readSecureState('signal-session', 'peer-1')).toEqual(
      secretState,
    );
    store.close();

    const databaseBytes = await readFile(join(directory, 'chat.db'));
    expect(databaseBytes.includes(secretState)).toBe(false);

    const reopened = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });
    expect(reopened.readSecureState('signal-session', 'peer-1')).toEqual(
      secretState,
    );
    expect(reopened.deleteSecureState('signal-session', 'peer-1')).toBe(true);
    expect(reopened.readSecureState('signal-session', 'peer-1')).toBeNull();
    reopened.close();
  });

  it('encrypts image filenames and content at rest', async () => {
    const directory = await temporaryDirectory();
    const peerDirectory = await temporaryDirectory();
    const passphrase = 'image encryption test passphrase';
    const store = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });
    const peerStore = await LocalStore.open({
      directory: peerDirectory,
      passphrase: 'image peer test passphrase',
      kdfOptions: testKdfOptions,
    });
    const conversationId = store.ensureConversation(peerStore.identity);
    const messageId = randomUUID();
    const attachmentId = randomUUID();
    const secretBytes = Buffer.from('unique-image-payload-secret-8491');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const image = prepareImage(
      Buffer.concat([png, secretBytes]),
      'private-screenshot-8491.png',
    );

    store.saveOutgoingImageMessage({
      conversationId,
      messageId,
      sequenceNumber: store.nextSequenceNumber(conversationId),
      body: '',
      sentAt: new Date().toISOString(),
      image: { ...image, id: attachmentId },
    });
    store.close();
    peerStore.close();

    const databaseBytes = await readFile(join(directory, 'chat.db'));
    expect(databaseBytes.includes(secretBytes)).toBe(false);
    expect(
      databaseBytes.includes(Buffer.from('private-screenshot-8491.png')),
    ).toBe(false);

    const reopened = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });
    const stored = reopened.listMessages(conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(messageId);
    expect(stored[0]?.image?.id).toBe(attachmentId);
    expect(stored[0]?.image?.filename).toBe('private-screenshot-8491.png');
    expect(stored[0]?.image?.mimeType).toBe('image/png');
    expect(reopened.readImageAttachment(attachmentId)).toEqual(image.bytes);
    reopened.close();
  });
});
