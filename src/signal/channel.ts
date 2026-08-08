import { randomBytes } from 'node:crypto';

import {
  CiphertextMessageType,
  PreKeySignalMessage,
  PublicKey,
  SignalMessage,
  processPreKeyBundle,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import { z } from 'zod';

import type { JsonChannel } from '../network/channel.js';
import type { LocalStore } from '../storage/local-store.js';
import { VIDEO_CALL_FEATURE } from '../call/protocol.js';
import { IMAGE_TRANSFER_FEATURE } from '../image/image.js';
import {
  PersistentSignalProtocolStore,
  deserializePreKeyBundle,
  ownedBytes,
  signalPreKeyBundleSchema,
} from './protocol-store.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_PLAINTEXT_BYTES = 24 * 1024;
const SIGNAL_WHISPER_MESSAGE_TYPE: number = CiphertextMessageType.Whisper;
const SIGNAL_PREKEY_MESSAGE_TYPE: number = CiphertextMessageType.PreKey;
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const peerId = base64Url.length(43);
const advertisedFeatureSchema = z.string().regex(/^[a-z0-9-]{1,64}$/u);
const localFeatures = [IMAGE_TRANSFER_FEATURE, VIDEO_CALL_FEATURE] as const;

export const signalOfferSchema = z.object({
  type: z.literal('signal-offer'),
  version: z.literal(1),
  sessionId: base64Url.length(22),
  challenge: base64Url.length(43),
  creatorPeerId: peerId,
  joinerPeerId: peerId,
  bundle: signalPreKeyBundleSchema,
  features: z.array(advertisedFeatureSchema).max(16).optional(),
});

export const signalWireFrameSchema = z.object({
  type: z.literal('signal-message'),
  version: z.literal(1),
  messageType: z.enum(['prekey', 'whisper']),
  ciphertext: base64Url.min(1).max(80_000),
});

const signalInitSchema = z.object({
  type: z.literal('signal-init'),
  version: z.literal(1),
  sessionId: base64Url.length(22),
  challenge: base64Url.length(43),
  creatorPeerId: peerId,
  joinerPeerId: peerId,
  signalIdentityKey: base64Url.min(40).max(128),
  features: z.array(advertisedFeatureSchema).max(16).optional(),
});

const signalReadySchema = z.object({
  type: z.literal('signal-ready'),
  version: z.literal(1),
  sessionId: base64Url.length(22),
  challenge: base64Url.length(43),
  creatorPeerId: peerId,
  joinerPeerId: peerId,
  signalIdentityKey: base64Url.min(40).max(128),
  features: z.array(advertisedFeatureSchema).max(16).optional(),
});

export type SignalFeature =
  typeof IMAGE_TRANSFER_FEATURE | typeof VIDEO_CALL_FEATURE;

export interface EstablishSignalChannelOptions {
  readonly inner: JsonChannel;
  readonly localStore: LocalStore;
  readonly peerId: string;
  readonly direction: 'creator' | 'joiner';
  readonly localFeatures?: readonly SignalFeature[];
}

export interface EstablishedSignalChannel {
  readonly channel: JsonChannel;
  readonly localIdentityKey: Buffer;
  readonly remoteIdentityKey: Buffer;
  readonly remoteFeatures: readonly SignalFeature[];
}

export async function establishSignalChannel(
  options: EstablishSignalChannelOptions,
): Promise<EstablishedSignalChannel> {
  const store = new PersistentSignalProtocolStore(options.localStore);
  store.clearSession(options.peerId);

  try {
    const advertisedFeatures = options.localFeatures ?? localFeatures;
    return options.direction === 'creator'
      ? await establishAsCreator(
          options.inner,
          store,
          options.peerId,
          advertisedFeatures,
        )
      : await establishAsJoiner(
          options.inner,
          store,
          options.peerId,
          advertisedFeatures,
        );
  } catch (error: unknown) {
    store.clearSession(options.peerId);
    throw error;
  }
}

async function establishAsCreator(
  inner: JsonChannel,
  store: PersistentSignalProtocolStore,
  remotePeerId: string,
  advertisedFeatures: readonly SignalFeature[],
): Promise<EstablishedSignalChannel> {
  const generatedBundle = store.createPreKeyBundle();
  const offer = signalOfferSchema.parse({
    type: 'signal-offer',
    version: 1,
    sessionId: randomBytes(16).toString('base64url'),
    challenge: randomBytes(32).toString('base64url'),
    creatorPeerId: store.localAddress.name(),
    joinerPeerId: remotePeerId,
    bundle: generatedBundle.data,
    features: advertisedFeatures,
  });
  const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);

  try {
    await inner.write(offer, signal);
    const frame = await inner.read(signalWireFrameSchema, signal);
    if (frame.messageType !== 'prekey') {
      throw new Error('Signal peer did not start a new PQXDH session');
    }
    const plaintext = await signalDecryptPreKey(
      PreKeySignalMessage.deserialize(
        ownedBytes(Buffer.from(frame.ciphertext, 'base64url')),
      ),
      store.remoteAddress(remotePeerId),
      store.localAddress,
      store.sessions,
      store.identities,
      store.preKeys,
      store.signedPreKeys,
      store.kyberPreKeys,
    );
    const init = parsePlaintext(signalInitSchema, plaintext);
    assertHandshakeBinding(init, offer);
    const remoteIdentityKey = requireRemoteIdentity(store, remotePeerId);
    assertSerializedIdentity(init.signalIdentityKey, remoteIdentityKey);

    const localIdentityKey = serializeKey(store.localIdentityPublicKey);
    const ready = signalReadySchema.parse({
      type: 'signal-ready',
      version: 1,
      sessionId: offer.sessionId,
      challenge: offer.challenge,
      creatorPeerId: offer.creatorPeerId,
      joinerPeerId: offer.joinerPeerId,
      signalIdentityKey: localIdentityKey.toString('base64url'),
      features: advertisedFeatures,
    });
    const encryptedReady = await signalEncrypt(
      encodePlaintext(ready),
      store.remoteAddress(remotePeerId),
      store.localAddress,
      store.sessions,
      store.identities,
    );
    if (encryptedReady.type() !== SIGNAL_WHISPER_MESSAGE_TYPE) {
      throw new Error('Signal ratchet did not enter the established state');
    }
    await inner.write(
      toWireFrame(encryptedReady.serialize(), 'whisper'),
      signal,
    );

    return {
      channel: new SignalJsonChannel(inner, store, remotePeerId),
      localIdentityKey,
      remoteIdentityKey: serializeKey(remoteIdentityKey),
      remoteFeatures: recognizedFeatures(init.features),
    };
  } finally {
    generatedBundle.discard();
  }
}

async function establishAsJoiner(
  inner: JsonChannel,
  store: PersistentSignalProtocolStore,
  remotePeerId: string,
  advertisedFeatures: readonly SignalFeature[],
): Promise<EstablishedSignalChannel> {
  const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
  const offer = await inner.read(signalOfferSchema, signal);
  if (
    offer.creatorPeerId !== remotePeerId ||
    offer.joinerPeerId !== store.localAddress.name()
  ) {
    throw new Error('Signal offer is not bound to the authenticated peers');
  }

  const bundle = deserializePreKeyBundle(offer.bundle);
  const previouslyTrusted = store.getRemoteIdentity(remotePeerId);
  if (
    previouslyTrusted !== null &&
    !previouslyTrusted.equals(bundle.identityKey())
  ) {
    throw new Error('Signal identity key changed for this peer');
  }
  await processPreKeyBundle(
    bundle,
    store.remoteAddress(remotePeerId),
    store.localAddress,
    store.sessions,
    store.identities,
  );
  const remoteIdentityKey = requireRemoteIdentity(store, remotePeerId);
  if (!remoteIdentityKey.equals(bundle.identityKey())) {
    throw new Error('Signal prekey bundle identity was not trusted');
  }

  const localIdentityKey = serializeKey(store.localIdentityPublicKey);
  const init = signalInitSchema.parse({
    type: 'signal-init',
    version: 1,
    sessionId: offer.sessionId,
    challenge: offer.challenge,
    creatorPeerId: offer.creatorPeerId,
    joinerPeerId: offer.joinerPeerId,
    signalIdentityKey: localIdentityKey.toString('base64url'),
    features: advertisedFeatures,
  });
  const encryptedInit = await signalEncrypt(
    encodePlaintext(init),
    store.remoteAddress(remotePeerId),
    store.localAddress,
    store.sessions,
    store.identities,
  );
  if (encryptedInit.type() !== SIGNAL_PREKEY_MESSAGE_TYPE) {
    throw new Error('Signal PQXDH did not produce a prekey message');
  }
  await inner.write(toWireFrame(encryptedInit.serialize(), 'prekey'), signal);

  const readyFrame = await inner.read(signalWireFrameSchema, signal);
  if (readyFrame.messageType !== 'whisper') {
    throw new Error('Signal peer sent an invalid session acknowledgement');
  }
  const readyPlaintext = await signalDecrypt(
    SignalMessage.deserialize(
      ownedBytes(Buffer.from(readyFrame.ciphertext, 'base64url')),
    ),
    store.remoteAddress(remotePeerId),
    store.localAddress,
    store.sessions,
    store.identities,
  );
  const ready = parsePlaintext(signalReadySchema, readyPlaintext);
  assertHandshakeBinding(ready, offer);
  assertSerializedIdentity(ready.signalIdentityKey, remoteIdentityKey);

  return {
    channel: new SignalJsonChannel(inner, store, remotePeerId),
    localIdentityKey,
    remoteIdentityKey: serializeKey(remoteIdentityKey),
    remoteFeatures: recognizedFeatures(offer.features),
  };
}

export class SignalJsonChannel implements JsonChannel {
  readonly #inner: JsonChannel;
  readonly #store: PersistentSignalProtocolStore;
  readonly #remotePeerId: string;
  readonly #protocolSerial = new SerialExecutor();
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(
    inner: JsonChannel,
    store: PersistentSignalProtocolStore,
    remotePeerId: string,
  ) {
    this.#inner = inner;
    this.#store = store;
    this.#remotePeerId = remotePeerId;
  }

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    const plaintext = encodePlaintext(value);
    const write = this.#writeTail.then(async () => {
      const ciphertext = await this.#protocolSerial.run(async () => {
        return await signalEncrypt(
          plaintext,
          this.#store.remoteAddress(this.#remotePeerId),
          this.#store.localAddress,
          this.#store.sessions,
          this.#store.identities,
        );
      });
      if (ciphertext.type() !== SIGNAL_WHISPER_MESSAGE_TYPE) {
        throw new Error('Signal session unexpectedly returned to prekey mode');
      }
      await this.#inner.write(
        toWireFrame(ciphertext.serialize(), 'whisper'),
        signal,
      );
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  public async read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    const frame = await this.#inner.read(signalWireFrameSchema, signal);
    if (frame.messageType !== 'whisper') {
      throw new Error('Unexpected Signal prekey message after setup');
    }
    const plaintext = await this.#protocolSerial.run(async () => {
      return await signalDecrypt(
        SignalMessage.deserialize(
          ownedBytes(Buffer.from(frame.ciphertext, 'base64url')),
        ),
        this.#store.remoteAddress(this.#remotePeerId),
        this.#store.localAddress,
        this.#store.sessions,
        this.#store.identities,
      );
    });
    return schema.parse(parseJson(plaintext));
  }

  public async close(): Promise<void> {
    await this.#writeTail.catch(() => undefined);
    await this.#inner.close();
  }

  public abort(error: Error): void {
    this.#inner.abort(error);
  }
}

class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  public async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function toWireFrame(
  ciphertext: Uint8Array,
  messageType: 'prekey' | 'whisper',
): z.output<typeof signalWireFrameSchema> {
  return signalWireFrameSchema.parse({
    type: 'signal-message',
    version: 1,
    messageType,
    ciphertext: Buffer.from(ciphertext).toString('base64url'),
  });
}

function encodePlaintext(value: unknown): Uint8Array<ArrayBuffer> {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('Signal plaintext frame is too large');
  }
  return ownedBytes(plaintext);
}

function parsePlaintext<Schema extends z.ZodType>(
  schema: Schema,
  plaintext: Uint8Array,
): z.output<Schema> {
  return schema.parse(parseJson(plaintext));
}

function parseJson(plaintext: Uint8Array): unknown {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('Signal plaintext frame is too large');
  }
  try {
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as unknown;
  } catch {
    throw new Error('Signal plaintext is not valid JSON');
  }
}

function assertHandshakeBinding(
  message: z.output<typeof signalInitSchema | typeof signalReadySchema>,
  offer: z.output<typeof signalOfferSchema>,
): void {
  if (
    message.sessionId !== offer.sessionId ||
    message.challenge !== offer.challenge ||
    message.creatorPeerId !== offer.creatorPeerId ||
    message.joinerPeerId !== offer.joinerPeerId
  ) {
    throw new Error('Signal handshake is not bound to this connection');
  }
}

function requireRemoteIdentity(
  store: PersistentSignalProtocolStore,
  peer: string,
): PublicKey {
  const key = store.getRemoteIdentity(peer);
  if (key === null) {
    throw new Error('Signal peer identity was not persisted');
  }
  return key;
}

function assertSerializedIdentity(encoded: string, expected: PublicKey): void {
  const received = PublicKey.deserialize(
    ownedBytes(Buffer.from(encoded, 'base64url')),
  );
  if (!received.equals(expected)) {
    throw new Error('Signal identity does not match the ratchet session');
  }
}

function serializeKey(key: PublicKey): Buffer {
  return Buffer.from(key.serialize());
}

function recognizedFeatures(
  features: readonly string[] | undefined,
): readonly SignalFeature[] {
  if (features === undefined) {
    return [];
  }
  const recognized: SignalFeature[] = [];
  if (features.includes(IMAGE_TRANSFER_FEATURE)) {
    recognized.push(IMAGE_TRANSFER_FEATURE);
  }
  if (features.includes(VIDEO_CALL_FEATURE)) {
    recognized.push(VIDEO_CALL_FEATURE);
  }
  return recognized;
}
