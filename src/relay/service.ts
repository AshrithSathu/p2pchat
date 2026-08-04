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
import { EncryptedJsonChannel } from './secure-channel.js';

import {
  createSafetyNumber,
  describePeerIdentity,
} from '../network/identity.js';
import type { AuthenticatedSession, InviteHandle } from '../network/service.js';
import { establishSignalChannel } from '../signal/channel.js';
import type { LocalStore } from '../storage/local-store.js';

export interface RelayServiceOptions {
  readonly endpoint: string;
}

export class RelayService {
  readonly #store: LocalStore;
  readonly #api: RelayApiClient;
  #cancelPending: ((error: Error) => void) | null = null;
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
    const connected = this.#acceptPeer(material.invite, rawChannel).finally(
      () => {
        this.#cancelPending = null;
      },
    );
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

  public stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#cancelPending?.(new Error('Internet relay stopped'));
    this.#cancelPending = null;
  }

  async #acceptPeer(
    invite: ReturnType<typeof createRelayRoomMaterial>['invite'],
    rawChannel: Awaited<ReturnType<RelayApiClient['connect']>>,
  ): Promise<AuthenticatedSession> {
    const handshake = new EncryptedJsonChannel(
      rawChannel,
      createPreSharedChannelKeys(invite, 'creator'),
    );
    try {
      const join = await handshake.read(relayJoinSchema);
      const authenticated = acceptRelayJoin(this.#store, invite, join);
      await handshake.write(authenticated.message);
      handshake.destroyKeys();
      const peer = describePeerIdentity(authenticated.peer.publicKey);
      const signalSession = await establishSignalChannel({
        inner: new EncryptedJsonChannel(rawChannel, authenticated.keys),
        localStore: this.#store,
        peerId: peer.id,
        direction: 'creator',
      });
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
