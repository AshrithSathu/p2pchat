import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KdfOptions } from './crypto.js';
import { InvalidPassphraseError, LocalStore } from './local-store.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};

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

  it('persists message history without storing plaintext bodies', async () => {
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
  });

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
});
