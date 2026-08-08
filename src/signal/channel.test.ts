import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JsonChannel } from '../network/channel.js';
import type { KdfOptions } from '../storage/crypto.js';
import { LocalStore } from '../storage/local-store.js';
import { establishSignalChannel } from './channel.js';

const testKdfOptions: KdfOptions = {
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 16 * 1024 * 1024,
};
const applicationSchema = z.object({
  sequence: z.number().int(),
  body: z.string(),
});
const directories: string[] = [];
const signalTestTimeout = 30_000;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('Signal channel', () => {
  it(
    'uses PQXDH, handles out-of-order messages, and rejects replays',
    async () => {
      const creatorStore = await createStore('creator');
      const joinerStore = await createStore('joiner');
      const [creatorRaw, joinerRaw] = memoryChannelPair();
      const [creator, joiner] = await Promise.all([
        establishSignalChannel({
          inner: creatorRaw,
          localStore: creatorStore,
          peerId: joinerStore.identity.id,
          direction: 'creator',
        }),
        establishSignalChannel({
          inner: joinerRaw,
          localStore: joinerStore,
          peerId: creatorStore.identity.id,
          direction: 'joiner',
        }),
      ]);

      expect(creator.localIdentityKey).toEqual(joiner.remoteIdentityKey);
      expect(creator.remoteIdentityKey).toEqual(joiner.localIdentityKey);
      expect(creator.remoteFeatures).toContain('image-v1');
      expect(joiner.remoteFeatures).toContain('image-v1');
      expect(creator.remoteFeatures).toContain('video-call-v1');
      expect(joiner.remoteFeatures).toContain('video-call-v1');

      const heldFrames: unknown[] = [];
      creatorRaw.outboundHook = (value) => heldFrames.push(value);
      await creator.channel.write({ sequence: 1, body: 'first' });
      await creator.channel.write({ sequence: 2, body: 'second' });
      creatorRaw.outboundHook = null;

      expect(heldFrames).toHaveLength(2);
      joinerRaw.push(heldFrames[1]);
      joinerRaw.push(heldFrames[0]);
      await expect(joiner.channel.read(applicationSchema)).resolves.toEqual({
        sequence: 2,
        body: 'second',
      });
      await expect(joiner.channel.read(applicationSchema)).resolves.toEqual({
        sequence: 1,
        body: 'first',
      });

      joinerRaw.push(heldFrames[0]);
      await expect(joiner.channel.read(applicationSchema)).rejects.toThrow();

      creatorStore.close();
      joinerStore.close();
    },
    signalTestTimeout,
  );

  it(
    'rejects a tampered ratchet ciphertext',
    async () => {
      const creatorStore = await createStore('tamper-creator');
      const joinerStore = await createStore('tamper-joiner');
      const [creatorRaw, joinerRaw] = memoryChannelPair();
      const [creator, joiner] = await Promise.all([
        establishSignalChannel({
          inner: creatorRaw,
          localStore: creatorStore,
          peerId: joinerStore.identity.id,
          direction: 'creator',
        }),
        establishSignalChannel({
          inner: joinerRaw,
          localStore: joinerStore,
          peerId: creatorStore.identity.id,
          direction: 'joiner',
        }),
      ]);

      creatorRaw.outboundHook = (value) => {
        const frame = z.object({ ciphertext: z.string() }).loose().parse(value);
        const replacement = frame.ciphertext.startsWith('A') ? 'B' : 'A';
        joinerRaw.push({
          ...frame,
          ciphertext: `${replacement}${frame.ciphertext.slice(1)}`,
        });
      };
      await creator.channel.write({ sequence: 1, body: 'authenticated' });
      await expect(joiner.channel.read(applicationSchema)).rejects.toThrow();

      creatorStore.close();
      joinerStore.close();
    },
    signalTestTimeout,
  );
});

async function createStore(label: string): Promise<LocalStore> {
  const directory = await mkdtemp(join(tmpdir(), `p2pchat-signal-${label}-`));
  directories.push(directory);
  return await LocalStore.open({
    directory,
    passphrase: `${label} Signal protocol test passphrase`,
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
  public outboundHook: ((value: unknown) => void) | null = null;
  readonly #queue: unknown[] = [];
  readonly #waiters: ((value: unknown) => void)[] = [];
  #failure: Error | null = null;

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw new Error('Memory channel write aborted');
    }
    const cloned = structuredClone(value);
    if (this.outboundHook !== null) {
      this.outboundHook(cloned);
      return;
    }
    if (this.peer === null) {
      throw new Error('Memory channel peer is missing');
    }
    this.peer.push(cloned);
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
