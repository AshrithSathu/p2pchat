import {
  createPreSharedChannelKeys,
  createRelayJoin,
  acceptRelayJoin,
  completeRelayJoin,
  relayAcceptSchema,
  relayJoinSchema,
} from './auth.js';
import { RelayApiClient } from './client.js';
import {
  createRelayRoomMaterial,
  decryptRelayInvite,
  deriveRelayLocator,
  isRelayInviteCode,
} from './invite.js';
import type { RelayLocator } from './invite.js';
import { EncryptedJsonChannel } from './secure-channel.js';

import {
  createSafetyNumber,
  describePeerIdentity,
} from '../network/identity.js';
import type { AuthenticatedSession, InviteHandle } from '../network/service.js';
import { establishSignalChannel } from '../signal/channel.js';
import type { LocalStore } from '../storage/local-store.js';
import type { TurnCredentials } from '../call/protocol.js';

interface ActiveRelayContext {
  readonly role: 'creator' | 'joiner';
  readonly locator: RelayLocator;
}

const TURN_PEER_RETRY_DELAYS_MS = [0, 200, 500, 1_000] as const;

export class RelayPeerOfflineError extends Error {
  public constructor(cause?: Error) {
    super('Peer is no longer connected', { cause });
    this.name = 'RelayPeerOfflineError';
  }
}

export interface RelayServiceOptions {
  readonly endpoint: string;
}

export class RelayService {
  readonly #store: LocalStore;
  readonly #api: RelayApiClient;
  #cancelPending: ((error: Error) => void) | null = null;
  #activeContext: ActiveRelayContext | null = null;
  #stopped = false;

  public constructor(store: LocalStore, options: RelayServiceOptions) {
    this.#store = store;
    this.#api = new RelayApiClient(options.endpoint);
  }

  public static isInviteCode(value: string): boolean {
    return isRelayInviteCode(value);
  }

  public async createInvite(ttlMs?: number): Promise<InviteHandle> {
    this.#assertRunning();
    if (this.#cancelPending !== null) {
      throw new Error('An Internet invite is already waiting for a peer');
    }

    const material = createRelayRoomMaterial(this.#store.identity, ttlMs);
    await this.#api.createRoom(material);
    const rawChannel = await this.#api.connect('creator', material);
    const connected = this.#acceptPeer(material, rawChannel).finally(() => {
      this.#cancelPending = null;
    });
    this.#cancelPending = (error) => rawChannel.abort(error);

    return {
      code: material.code,
      expiresAt: material.invite.expiresAt,
      connected,
      cancel: () => rawChannel.abort(new Error('Internet invite cancelled')),
    };
  }

  public async join(code: string): Promise<AuthenticatedSession> {
    this.#assertRunning();
    const locator = deriveRelayLocator(code);
    const encryptedInvite = await this.#api.fetchEncryptedInvite(locator);
    const invite = decryptRelayInvite(locator, encryptedInvite);
    const rawChannel = await this.#api.connect('joiner', locator);
    const handshake = new EncryptedJsonChannel(
      rawChannel,
      createPreSharedChannelKeys(invite, 'joiner'),
    );

    try {
      const state = createRelayJoin(this.#store, invite);
      await handshake.write(state.message, AbortSignal.timeout(15_000));
      const accept = await handshake.read(
        relayAcceptSchema,
        AbortSignal.timeout(15_000),
      );
      const authenticated = completeRelayJoin(
        this.#store,
        invite,
        state,
        accept,
      );
      handshake.destroyKeys();
      const signalSession = await establishSignalChannel({
        inner: new EncryptedJsonChannel(rawChannel, authenticated.keys),
        localStore: this.#store,
        peerId: authenticated.peer.id,
        direction: 'joiner',
      });
      this.#activeContext = { role: 'joiner', locator };
      return {
        channel: signalSession.channel,
        peer: authenticated.peer,
        safetyNumber: createSafetyNumber(
          authenticated.peer.publicKey,
          this.#store.identity.publicKey,
          signalSession.remoteIdentityKey,
          signalSession.localIdentityKey,
        ),
        remoteNetworkPeerId: 'cloudflare-relay',
        direction: 'joiner',
        transport: 'relay',
        remoteFeatures: signalSession.remoteFeatures,
      };
    } catch (error: unknown) {
      const failure =
        error instanceof Error
          ? error
          : new Error('Internet relay authentication failed');
      handshake.abort(failure);
      throw failure;
    }
  }

  public async createTurnCredentials(callId: string): Promise<TurnCredentials> {
    this.#assertRunning();
    const context = this.#activeContext;
    if (context === null) {
      throw new Error('Connect to a peer before starting a video call');
    }
    return await requestTurnCredentialsWithPeerRetry(
      async () =>
        await this.#api.fetchTurnCredentials(
          context.role,
          context.locator,
          callId,
        ),
    );
  }

  public stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#cancelPending?.(new Error('Internet relay stopped'));
    this.#cancelPending = null;
    this.#activeContext = null;
  }

  async #acceptPeer(
    material: ReturnType<typeof createRelayRoomMaterial>,
    rawChannel: Awaited<ReturnType<RelayApiClient['connect']>>,
  ): Promise<AuthenticatedSession> {
    const handshake = new EncryptedJsonChannel(
      rawChannel,
      createPreSharedChannelKeys(material.invite, 'creator'),
    );
    try {
      const join = await handshake.read(relayJoinSchema);
      const authenticated = acceptRelayJoin(this.#store, material.invite, join);
      await handshake.write(authenticated.message);
      handshake.destroyKeys();
      const peer = describePeerIdentity(authenticated.peer.publicKey);
      const signalSession = await establishSignalChannel({
        inner: new EncryptedJsonChannel(rawChannel, authenticated.keys),
        localStore: this.#store,
        peerId: peer.id,
        direction: 'creator',
      });
      this.#activeContext = { role: 'creator', locator: material };
      return {
        channel: signalSession.channel,
        peer,
        safetyNumber: createSafetyNumber(
          this.#store.identity.publicKey,
          peer.publicKey,
          signalSession.localIdentityKey,
          signalSession.remoteIdentityKey,
        ),
        remoteNetworkPeerId: 'cloudflare-relay',
        direction: 'creator',
        transport: 'relay',
        remoteFeatures: signalSession.remoteFeatures,
      };
    } catch (error: unknown) {
      const failure =
        error instanceof Error
          ? error
          : new Error('Internet relay authentication failed');
      handshake.abort(failure);
      throw failure;
    }
  }

  #assertRunning(): void {
    if (this.#stopped) {
      throw new Error('Internet relay is stopped');
    }
  }
}

export async function requestTurnCredentialsWithPeerRetry(
  request: () => Promise<TurnCredentials>,
  retryDelaysMs: readonly number[] = TURN_PEER_RETRY_DELAYS_MS,
): Promise<TurnCredentials> {
  let peerOfflineCause: Error | undefined;
  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    try {
      return await request();
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Relay peer is not connected'
      ) {
        throw error;
      }
      peerOfflineCause = error;
    }
  }
  throw new RelayPeerOfflineError(peerOfflineCause);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
