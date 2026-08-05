import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import type { Stream } from '@libp2p/interface';
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p, type Libp2p } from 'libp2p';

import type { LocalStore } from '../storage/local-store.js';
import { APP_VERSION } from '../core/version.js';
import type { JsonChannel } from './channel.js';
import {
  createAcceptMessage,
  createJoinMessage,
  createJoinTranscript,
  verifyAcceptMessage,
  verifyJoinMessage,
} from './auth.js';
import {
  createSafetyNumber,
  describePeerIdentity,
  type PeerIdentity,
} from './identity.js';
import {
  createInvitePayload,
  decodeInviteCode,
  encodeInviteCode,
  type InvitePayload,
} from './invite.js';
import {
  FrameChannel,
  handshakeResponseSchema,
  joinMessageSchema,
  type ErrorMessage,
} from './protocol.js';
import { establishSignalChannel } from '../signal/channel.js';

export const CHAT_PROTOCOL = '/p2pchat/1.0.0';
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface AuthenticatedSession {
  readonly channel: JsonChannel;
  readonly peer: PeerIdentity;
  readonly safetyNumber: string;
  readonly remoteNetworkPeerId: string;
  readonly direction: 'creator' | 'joiner';
  readonly transport: 'direct' | 'relay';
}

export interface InviteHandle {
  readonly code: string;
  readonly expiresAt: number;
  readonly connected: Promise<AuthenticatedSession>;
  cancel(): void;
}

export interface P2PServiceOptions {
  readonly listenAddresses?: readonly string[];
}

interface PendingInvite {
  readonly invite: InvitePayload;
  readonly resolve: (session: AuthenticatedSession) => void;
  readonly reject: (error: Error) => void;
  used: boolean;
}

function protocolError(
  code: ErrorMessage['code'],
  message: string,
): ErrorMessage {
  return { type: 'error', code, message };
}

export class P2PService {
  readonly #node: Libp2p;
  readonly #store: LocalStore;
  #pendingInvite: PendingInvite | null = null;
  #stopped = false;

  private constructor(node: Libp2p, store: LocalStore) {
    this.#node = node;
    this.#store = store;
  }

  public static async start(
    store: LocalStore,
    options: P2PServiceOptions = {},
  ): Promise<P2PService> {
    const node = await createLibp2p({
      addresses: {
        listen: [...(options.listenAddresses ?? ['/ip4/0.0.0.0/tcp/0'])],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: 16,
      },
      services: {
        identify: identify(),
      },
      nodeInfo: {
        name: 'p2pchat',
        version: APP_VERSION,
      },
    });

    const service = new P2PService(node, store);
    await node.handle(
      CHAT_PROTOCOL,
      async (stream, connection) => {
        await service.#handleIncoming(stream, connection.remotePeer.toString());
      },
      {
        maxInboundStreams: 1,
        maxOutboundStreams: 1,
      },
    );
    return service;
  }

  public get networkPeerId(): string {
    return this.#node.peerId.toString();
  }

  public createInvite(ttlMs?: number): InviteHandle {
    this.#assertRunning();
    if (this.#pendingInvite !== null) {
      throw new Error('An invite is already waiting for a peer');
    }

    const addresses = this.#node
      .getMultiaddrs()
      .map((address) => address.toString())
      .filter(
        (address) =>
          !address.includes('/ip4/0.0.0.0/') && !address.includes('/ip6/::/'),
      );

    if (addresses.length === 0) {
      throw new Error('No dialable local address is available');
    }

    const identity = this.#store.identity;
    const invite = createInvitePayload({
      addresses,
      creatorIdentityId: identity.id,
      creatorPublicKey: identity.publicKey,
      creatorNetworkPeerId: this.networkPeerId,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });

    const {
      promise: connected,
      resolve,
      reject,
    } = Promise.withResolvers<AuthenticatedSession>();
    const pending: PendingInvite = { invite, resolve, reject, used: false };
    this.#pendingInvite = pending;

    return {
      code: encodeInviteCode(invite),
      expiresAt: invite.expiresAt,
      connected,
      cancel: () => {
        if (this.#pendingInvite === pending) {
          this.#pendingInvite = null;
          pending.reject(new Error('Invite cancelled'));
        }
      },
    };
  }

  public async join(code: string): Promise<AuthenticatedSession> {
    this.#assertRunning();
    const invite = decodeInviteCode(code);
    const addresses = invite.addresses.map((address) => multiaddr(address));
    const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
    const stream = await this.#node.dialProtocol(addresses, CHAT_PROTOCOL, {
      signal,
    });
    const channel = new FrameChannel(stream);

    try {
      const join = createJoinMessage(this.#store, invite, this.networkPeerId);
      const joinTranscript = createJoinTranscript(
        invite,
        join.identityId,
        Buffer.from(join.publicKey, 'base64url'),
        join.networkPeerId,
        join.nonce,
      );
      await channel.write(join, signal);
      const response = await channel.read(handshakeResponseSchema, signal);

      if (response.type === 'error') {
        throw new Error(response.message);
      }

      verifyAcceptMessage(this.#store, invite, joinTranscript, response);
      const peer = describePeerIdentity(
        Buffer.from(invite.creatorPublicKey, 'base64url'),
      );
      const signalSession = await establishSignalChannel({
        inner: channel,
        localStore: this.#store,
        peerId: peer.id,
        direction: 'joiner',
      });

      return {
        channel: signalSession.channel,
        peer,
        safetyNumber: createSafetyNumber(
          peer.publicKey,
          this.#store.identity.publicKey,
          signalSession.remoteIdentityKey,
          signalSession.localIdentityKey,
        ),
        remoteNetworkPeerId: invite.creatorNetworkPeerId,
        direction: 'joiner',
        transport: 'direct',
      };
    } catch (error: unknown) {
      const failure =
        error instanceof Error ? error : new Error('Authentication failed');
      channel.abort(failure);
      throw failure;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }

    this.#stopped = true;
    if (this.#pendingInvite !== null) {
      this.#pendingInvite.reject(new Error('Network stopped'));
      this.#pendingInvite = null;
    }
    await this.#node.stop();
  }

  async #handleIncoming(
    stream: Stream,
    transportPeerId: string,
  ): Promise<void> {
    const channel = new FrameChannel(stream);
    const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
    const pending = this.#pendingInvite;

    if (pending === null || pending.used) {
      await channel.write(
        protocolError('invite_unavailable', 'Invite is no longer available'),
        signal,
      );
      await channel.close();
      return;
    }

    if (pending.invite.expiresAt <= Date.now()) {
      this.#pendingInvite = null;
      pending.reject(new Error('Invite expired'));
      await channel.write(
        protocolError('expired', 'Invite has expired'),
        signal,
      );
      await channel.close();
      return;
    }

    try {
      const join = await channel.read(joinMessageSchema, signal);
      const joinTranscript = verifyJoinMessage(
        this.#store,
        pending.invite,
        join,
        transportPeerId,
      );
      const accept = createAcceptMessage(
        this.#store,
        pending.invite,
        joinTranscript,
      );
      await channel.write(accept, signal);

      pending.used = true;
      this.#pendingInvite = null;
      const peer = describePeerIdentity(
        Buffer.from(join.publicKey, 'base64url'),
      );
      const signalSession = await establishSignalChannel({
        inner: channel,
        localStore: this.#store,
        peerId: peer.id,
        direction: 'creator',
      });
      pending.resolve({
        channel: signalSession.channel,
        peer,
        safetyNumber: createSafetyNumber(
          this.#store.identity.publicKey,
          peer.publicKey,
          signalSession.localIdentityKey,
          signalSession.remoteIdentityKey,
        ),
        remoteNetworkPeerId: join.networkPeerId,
        direction: 'creator',
        transport: 'direct',
      });
    } catch (error: unknown) {
      const failure =
        error instanceof Error ? error : new Error('Authentication failed');
      if (this.#pendingInvite === pending) {
        this.#pendingInvite = null;
      }
      pending.used = true;
      pending.reject(failure);
      try {
        await channel.write(
          protocolError('auth_failed', 'Authentication failed'),
          signal,
        );
      } catch {
        // The remote may already have closed the stream.
      }
      channel.abort(failure);
    }
  }

  #assertRunning(): void {
    if (this.#stopped) {
      throw new Error('P2P network is stopped');
    }
  }
}
