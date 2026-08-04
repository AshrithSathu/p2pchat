import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JsonChannel } from '../network/channel.js';
import type { KdfOptions } from '../storage/crypto.js';
import { LocalStore } from '../storage/local-store.js';
import {
  acceptRelayJoin,
  completeRelayJoin,
  createPreSharedChannelKeys,
  createRelayJoin,
  relayAcceptSchema,
  relayJoinSchema,
} from './auth.js';
import { createRelayRoomMaterial } from './invite.js';
import { EncryptedJsonChannel } from './secure-channel.js';

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

describe('relay authentication', () => {
  it('derives matching forward-secret directional channels', async () => {
    const creatorStore = await createStore('creator');
    const joinerStore = await createStore('joiner');
    const invite = createRelayRoomMaterial(
      creatorStore.identity,
      60_000,
    ).invite;
    const [creatorRaw, joinerRaw] = memoryChannelPair();
    const creatorHandshake = new EncryptedJsonChannel(
      creatorRaw,
      createPreSharedChannelKeys(invite, 'creator'),
    );
    const joinerHandshake = new EncryptedJsonChannel(
      joinerRaw,
      createPreSharedChannelKeys(invite, 'joiner'),
    );

    const joinState = createRelayJoin(joinerStore, invite);
    await joinerHandshake.write(joinState.message);
    const joinMessage = await creatorHandshake.read(relayJoinSchema);
    const creatorAuth = acceptRelayJoin(creatorStore, invite, joinMessage);
    await creatorHandshake.write(creatorAuth.message);
    const acceptMessage = await joinerHandshake.read(relayAcceptSchema);
    const joinerAuth = completeRelayJoin(
      joinerStore,
      invite,
      joinState,
      acceptMessage,
    );
    creatorHandshake.destroyKeys();
    joinerHandshake.destroyKeys();

    expect(creatorAuth.peer.id).toBe(joinerStore.identity.id);
    expect(joinerAuth.peer.id).toBe(creatorStore.identity.id);

    const creatorSession = new EncryptedJsonChannel(
      creatorRaw,
      creatorAuth.keys,
    );
    const joinerSession = new EncryptedJsonChannel(joinerRaw, joinerAuth.keys);
    const applicationSchema = z.object({
      type: z.literal('test-message'),
      body: z.string(),
    });
    await creatorSession.write({
      type: 'test-message',
      body: 'Cloudflare only receives ciphertext',
    });
    await expect(joinerSession.read(applicationSchema)).resolves.toEqual({
      type: 'test-message',
      body: 'Cloudflare only receives ciphertext',
    });

    await Promise.all([creatorSession.close(), joinerSession.close()]);
    creatorStore.close();
    joinerStore.close();
  });
});

async function createStore(label: string): Promise<LocalStore> {
  const directory = await mkdtemp(join(tmpdir(), `p2pchat-relay-${label}-`));
  directories.push(directory);
  return await LocalStore.open({
    directory,
    passphrase: `${label} relay authentication passphrase`,
    kdfOptions: testKdfOptions,
  });
}

function memoryChannelPair(): readonly [MemoryChannel, MemoryChannel] {
  const first = new MemoryChannel();
  const second = new MemoryChannel();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

class MemoryChannel implements JsonChannel {
  public peer: MemoryChannel | null = null;
  readonly #queue: unknown[] = [];
  readonly #waiters: ((value: unknown) => void)[] = [];
  #failure: Error | null = null;

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw new Error('Memory channel write aborted');
    }
    if (this.peer === null) {
      throw new Error('Memory channel peer is missing');
    }
    this.peer.push(structuredClone(value));
  }

  public async read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    if (signal?.aborted === true) {
      throw new Error('Memory channel read aborted');
    }
    if (this.#failure !== null) {
      throw this.#failure;
    }
    const queued = this.#queue.shift();
    const value =
      queued === undefined
        ? await new Promise<unknown>((resolve) => this.#waiters.push(resolve))
        : queued;
    return schema.parse(value);
  }

  public async close(): Promise<void> {
    this.abort(new Error('Memory channel closed'));
  }

  public abort(error: Error): void {
    this.#failure = error;
  }

  public push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(value);
    } else {
      waiter(value);
    }
  }
}
