import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

import { z } from 'zod';

import type { JsonChannel } from '../network/channel.js';

const MAX_PLAINTEXT_BYTES = 60 * 1024;
const TAG_LENGTH = 16;

const encryptedFrameSchema = z.object({
  type: z.literal('encrypted'),
  version: z.literal(1),
  counter: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/u)
    .max(20),
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .min(22)
    .max(90_000),
});

export interface DirectionalChannelKeys {
  readonly sessionId: string;
  readonly sendKey: Uint8Array;
  readonly receiveKey: Uint8Array;
  readonly sendLabel: string;
  readonly receiveLabel: string;
}

export class EncryptedJsonChannel implements JsonChannel {
  readonly #inner: JsonChannel;
  readonly #sessionId: string;
  readonly #sendKey: Buffer;
  readonly #receiveKey: Buffer;
  readonly #sendLabel: string;
  readonly #receiveLabel: string;
  #sendCounter = 0n;
  #receiveCounter = 0n;
  #writeTail: Promise<void> = Promise.resolve();
  #destroyed = false;

  public constructor(inner: JsonChannel, keys: DirectionalChannelKeys) {
    this.#inner = inner;
    this.#sessionId = keys.sessionId;
    this.#sendKey = Buffer.from(keys.sendKey);
    this.#receiveKey = Buffer.from(keys.receiveKey);
    this.#sendLabel = keys.sendLabel;
    this.#receiveLabel = keys.receiveLabel;
  }

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    this.#assertUsable();
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error('Encrypted protocol frame is too large');
    }
    const counter = this.#sendCounter;
    this.#sendCounter += 1n;
    const nonce = counterNonce(counter);
    const cipher = createCipheriv('aes-256-gcm', this.#sendKey, nonce, {
      authTagLength: TAG_LENGTH,
    });
    cipher.setAAD(this.#aad(this.#sendLabel, counter));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const ciphertext = Buffer.concat([cipher.getAuthTag(), encrypted]).toString(
      'base64url',
    );
    const frame = {
      type: 'encrypted',
      version: 1,
      counter: counter.toString(),
      ciphertext,
    } as const;
    const write = this.#writeTail.then(async () => {
      await this.#inner.write(frame, signal);
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  public async read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    this.#assertUsable();
    const frame = await this.#inner.read(encryptedFrameSchema, signal);
    const counter = BigInt(frame.counter);
    if (counter !== this.#receiveCounter) {
      throw new Error('Encrypted frame counter is invalid');
    }
    const value = Buffer.from(frame.ciphertext, 'base64url');
    if (value.byteLength < TAG_LENGTH) {
      throw new Error('Encrypted frame is malformed');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#receiveKey,
      counterNonce(counter),
      { authTagLength: TAG_LENGTH },
    );
    decipher.setAAD(this.#aad(this.#receiveLabel, counter));
    decipher.setAuthTag(value.subarray(0, TAG_LENGTH));
    let decoded: unknown;
    try {
      const plaintext = Buffer.concat([
        decipher.update(value.subarray(TAG_LENGTH)),
        decipher.final(),
      ]);
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new Error('Decrypted protocol frame is too large');
      }
      decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw new Error('Relay frame authentication failed');
    }
    this.#receiveCounter += 1n;
    return schema.parse(decoded);
  }

  public async close(): Promise<void> {
    this.destroyKeys();
    await this.#inner.close();
  }

  public abort(error: Error): void {
    this.destroyKeys();
    this.#inner.abort(error);
  }

  public destroyKeys(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#sendKey.fill(0);
    this.#receiveKey.fill(0);
  }

  #aad(label: string, counter: bigint): Buffer {
    return createHash('sha256')
      .update('p2pchat-encrypted-frame-v1\0')
      .update(this.#sessionId)
      .update('\0')
      .update(label)
      .update('\0')
      .update(counter.toString())
      .digest();
  }

  #assertUsable(): void {
    if (this.#destroyed) {
      throw new Error('Encrypted channel keys were destroyed');
    }
  }
}

function counterNonce(counter: bigint): Buffer {
  if (counter < 0n || counter > 0xffff_ffff_ffff_ffffn) {
    throw new Error('Encrypted frame counter is exhausted');
  }
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}
