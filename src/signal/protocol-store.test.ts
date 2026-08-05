import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Direction } from '@signalapp/libsignal-client';
import { afterEach, describe, expect, it } from 'vitest';

import type { KdfOptions } from '../storage/crypto.js';
import { LocalStore } from '../storage/local-store.js';
import {
  PersistentSignalProtocolStore,
  deserializePreKeyBundle,
} from './protocol-store.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('PersistentSignalProtocolStore', () => {
  it('persists the Signal identity and securely discards invite prekeys', async () => {
    const directory = await temporaryDirectory('persistence');
    const passphrase = 'persistent Signal identity passphrase';
    const firstStore = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });
    const firstProtocol = new PersistentSignalProtocolStore(firstStore);
    const publicIdentity = firstProtocol.localIdentityPublicKey.serialize();
    const generated = firstProtocol.createPreKeyBundle();

    expect(
      firstStore.readSecureState(
        'signal-prekey',
        String(generated.data.preKeyId),
      ),
    ).not.toBeNull();
    generated.discard();
    expect(
      firstStore.readSecureState(
        'signal-prekey',
        String(generated.data.preKeyId),
      ),
    ).toBeNull();
    expect(
      firstStore.readSecureState(
        'signal-signed-prekey',
        String(generated.data.signedPreKeyId),
      ),
    ).toBeNull();
    expect(
      firstStore.readSecureState(
        'signal-kyber-prekey',
        String(generated.data.kyberPreKeyId),
      ),
    ).toBeNull();
    firstStore.close();

    const reopened = await LocalStore.open({
      directory,
      passphrase,
      kdfOptions: testKdfOptions,
    });
    const reopenedProtocol = new PersistentSignalProtocolStore(reopened);
    expect(reopenedProtocol.localIdentityPublicKey.serialize()).toEqual(
      publicIdentity,
    );
    reopened.close();
  });

  it('does not trust a changed Signal identity for the same peer', async () => {
    const localStore = await createStore('local');
    const remoteStore = await createStore('remote');
    const localProtocol = new PersistentSignalProtocolStore(localStore);
    const originalRemote = new PersistentSignalProtocolStore(remoteStore);
    const originalBundle = originalRemote.createPreKeyBundle();
    const originalKey = deserializePreKeyBundle(
      originalBundle.data,
    ).identityKey();
    const remoteAddress = localProtocol.remoteAddress(remoteStore.identity.id);

    await localProtocol.identities.saveIdentity(remoteAddress, originalKey);
    remoteStore.deleteSecureState('signal-local', 'identity-v1');
    const replacementRemote = new PersistentSignalProtocolStore(remoteStore);
    const replacementBundle = replacementRemote.createPreKeyBundle();
    const replacementKey = deserializePreKeyBundle(
      replacementBundle.data,
    ).identityKey();

    expect(replacementKey.equals(originalKey)).toBe(false);
    await expect(
      localProtocol.identities.isTrustedIdentity(
        remoteAddress,
        replacementKey,
        Direction.Receiving,
      ),
    ).resolves.toBe(false);

    originalBundle.discard();
    replacementBundle.discard();
    localStore.close();
    remoteStore.close();
  }, 20_000);
});

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `p2pchat-signal-${label}-`));
  directories.push(directory);
  return directory;
}

async function createStore(label: string): Promise<LocalStore> {
  return await LocalStore.open({
    directory: await temporaryDirectory(label),
    passphrase: `${label} Signal protocol store passphrase`,
    kdfOptions: testKdfOptions,
  });
}
