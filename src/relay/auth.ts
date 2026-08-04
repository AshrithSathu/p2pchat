import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import { z } from 'zod';

import {
  describePeerIdentity,
  type PeerIdentity,
} from '../network/identity.js';
import type { LocalStore } from '../storage/local-store.js';
import type { RelayInvitePayload } from './invite.js';
import type { DirectionalChannelKeys } from './secure-channel.js';

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const relayJoinSchema = z.object({
  type: z.literal('relay-join'),
  version: z.literal(1),
  inviteId: base64Url.length(22),
  identityId: base64Url.length(43),
  publicKey: base64Url.min(40).max(128),
  ephemeralPublicKey: base64Url.min(40).max(128),
  nonce: base64Url.length(22),
  proof: base64Url.length(43),
  signature: base64Url.min(80).max(128),
});

export const relayAcceptSchema = z.object({
  type: z.literal('relay-accept'),
  version: z.literal(1),
  inviteId: base64Url.length(22),
  creatorIdentityId: base64Url.length(43),
  ephemeralPublicKey: base64Url.min(40).max(128),
  nonce: base64Url.length(22),
  proof: base64Url.length(43),
  signature: base64Url.min(80).max(128),
});

export type RelayJoin = z.infer<typeof relayJoinSchema>;
export type RelayAccept = z.infer<typeof relayAcceptSchema>;

export interface RelayJoinState {
  readonly message: RelayJoin;
  readonly privateKey: KeyObject;
  readonly transcript: Buffer;
}

export interface RelayAuthenticationResult {
  readonly peer: PeerIdentity;
  readonly keys: DirectionalChannelKeys;
}

export function createPreSharedChannelKeys(
  invite: RelayInvitePayload,
  role: 'creator' | 'joiner',
): DirectionalChannelKeys {
  const keyMaterial = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(invite.secret, 'base64url'),
      createHash('sha256').update(invite.inviteId).digest(),
      Buffer.from('p2pchat-relay-handshake-v1', 'utf8'),
      64,
    ),
  );
  const sessionId = createHash('sha256')
    .update('p2pchat-relay-handshake-session-v1\0')
    .update(invite.inviteId)
    .digest('base64url');
  const keys = directionalKeys(
    keyMaterial,
    sessionId,
    role,
    'creator-handshake',
    'joiner-handshake',
  );
  keyMaterial.fill(0);
  return keys;
}

export function createRelayJoin(
  store: LocalStore,
  invite: RelayInvitePayload,
): RelayJoinState {
  const identity = store.identity;
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublicKey = ephemeral.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const nonce = randomBytes(16).toString('base64url');
  const value = joinTranscript(
    invite,
    identity.id,
    identity.publicKey,
    ephemeralPublicKey,
    nonce,
  );
  return {
    message: {
      type: 'relay-join',
      version: 1,
      inviteId: invite.inviteId,
      identityId: identity.id,
      publicKey: identity.publicKey.toString('base64url'),
      ephemeralPublicKey: ephemeralPublicKey.toString('base64url'),
      nonce,
      proof: proof(invite.secret, value),
      signature: store.sign(value).toString('base64url'),
    },
    privateKey: ephemeral.privateKey,
    transcript: value,
  };
}

export function acceptRelayJoin(
  store: LocalStore,
  invite: RelayInvitePayload,
  message: RelayJoin,
): { readonly message: RelayAccept } & RelayAuthenticationResult {
  const joinValue = verifyRelayJoin(store, invite, message);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublicKey = ephemeral.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const nonce = randomBytes(16).toString('base64url');
  const acceptValue = acceptTranscript(joinValue, ephemeralPublicKey, nonce);
  const accept: RelayAccept = {
    type: 'relay-accept',
    version: 1,
    inviteId: invite.inviteId,
    creatorIdentityId: invite.creatorIdentityId,
    ephemeralPublicKey: ephemeralPublicKey.toString('base64url'),
    nonce,
    proof: proof(invite.secret, acceptValue),
    signature: store.sign(acceptValue).toString('base64url'),
  };
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519PublicKey(message.ephemeralPublicKey),
  });
  const keys = createSessionKeys(
    invite,
    sharedSecret,
    joinValue,
    acceptValue,
    'creator',
  );
  sharedSecret.fill(0);
  return {
    message: accept,
    peer: describePeerIdentity(Buffer.from(message.publicKey, 'base64url')),
    keys,
  };
}

export function completeRelayJoin(
  store: LocalStore,
  invite: RelayInvitePayload,
  state: RelayJoinState,
  message: RelayAccept,
): RelayAuthenticationResult {
  if (
    message.inviteId !== invite.inviteId ||
    message.creatorIdentityId !== invite.creatorIdentityId
  ) {
    throw new Error('Relay acceptance is not bound to this invite');
  }
  const acceptValue = acceptTranscript(
    state.transcript,
    Buffer.from(message.ephemeralPublicKey, 'base64url'),
    message.nonce,
  );
  if (!verifyProof(invite.secret, acceptValue, message.proof)) {
    throw new Error('Relay acceptance proof is invalid');
  }
  if (
    !store.verify(
      Buffer.from(invite.creatorPublicKey, 'base64url'),
      acceptValue,
      Buffer.from(message.signature, 'base64url'),
    )
  ) {
    throw new Error('Relay creator signature is invalid');
  }
  const sharedSecret = diffieHellman({
    privateKey: state.privateKey,
    publicKey: x25519PublicKey(message.ephemeralPublicKey),
  });
  const keys = createSessionKeys(
    invite,
    sharedSecret,
    state.transcript,
    acceptValue,
    'joiner',
  );
  sharedSecret.fill(0);
  return {
    peer: describePeerIdentity(
      Buffer.from(invite.creatorPublicKey, 'base64url'),
    ),
    keys,
  };
}

function verifyRelayJoin(
  store: LocalStore,
  invite: RelayInvitePayload,
  message: RelayJoin,
): Buffer {
  if (message.inviteId !== invite.inviteId) {
    throw new Error('Relay join is not bound to this invite');
  }
  const publicKey = Buffer.from(message.publicKey, 'base64url');
  const peer = describePeerIdentity(publicKey);
  if (peer.id !== message.identityId) {
    throw new Error('Relay join identity is inconsistent');
  }
  const value = joinTranscript(
    invite,
    message.identityId,
    publicKey,
    Buffer.from(message.ephemeralPublicKey, 'base64url'),
    message.nonce,
  );
  if (!verifyProof(invite.secret, value, message.proof)) {
    throw new Error('Relay join proof is invalid');
  }
  if (
    !store.verify(publicKey, value, Buffer.from(message.signature, 'base64url'))
  ) {
    throw new Error('Relay join signature is invalid');
  }
  x25519PublicKey(message.ephemeralPublicKey);
  return value;
}

function createSessionKeys(
  invite: RelayInvitePayload,
  sharedSecret: Uint8Array,
  joinValue: Uint8Array,
  acceptValue: Uint8Array,
  role: 'creator' | 'joiner',
): DirectionalChannelKeys {
  const transcriptHash = createHash('sha256')
    .update(joinValue)
    .update(acceptValue)
    .digest();
  const inputKeyMaterial = Buffer.concat([
    Buffer.from(sharedSecret),
    Buffer.from(invite.secret, 'base64url'),
  ]);
  const keyMaterial = Buffer.from(
    hkdfSync(
      'sha256',
      inputKeyMaterial,
      transcriptHash,
      Buffer.from('p2pchat-relay-session-keys-v1', 'utf8'),
      64,
    ),
  );
  inputKeyMaterial.fill(0);
  const sessionId = createHmac('sha256', keyMaterial)
    .update('p2pchat-relay-session-id-v1\0')
    .update(transcriptHash)
    .digest('base64url');
  const keys = directionalKeys(
    keyMaterial,
    sessionId,
    role,
    'creator-to-joiner',
    'joiner-to-creator',
  );
  keyMaterial.fill(0);
  return keys;
}

function directionalKeys(
  material: Uint8Array,
  sessionId: string,
  role: 'creator' | 'joiner',
  creatorLabel: string,
  joinerLabel: string,
): DirectionalChannelKeys {
  const creatorKey = Buffer.from(material.subarray(0, 32));
  const joinerKey = Buffer.from(material.subarray(32, 64));
  return role === 'creator'
    ? {
        sessionId,
        sendKey: creatorKey,
        receiveKey: joinerKey,
        sendLabel: creatorLabel,
        receiveLabel: joinerLabel,
      }
    : {
        sessionId,
        sendKey: joinerKey,
        receiveKey: creatorKey,
        sendLabel: joinerLabel,
        receiveLabel: creatorLabel,
      };
}

function joinTranscript(
  invite: RelayInvitePayload,
  identityId: string,
  publicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: string,
): Buffer {
  return transcript([
    'p2pchat-relay-join-v1',
    invite.inviteId,
    invite.creatorIdentityId,
    identityId,
    publicKey,
    ephemeralPublicKey,
    nonce,
  ]);
}

function acceptTranscript(
  joinValue: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: string,
): Buffer {
  return transcript([
    'p2pchat-relay-accept-v1',
    createHash('sha256').update(joinValue).digest(),
    ephemeralPublicKey,
    nonce,
  ]);
}

function transcript(parts: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(
    parts.map((part) => {
      const value = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(value.byteLength);
      return Buffer.concat([prefix, value]);
    }),
  );
}

function proof(secret: string, value: Uint8Array): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(value)
    .digest('base64url');
}

function verifyProof(
  secret: string,
  value: Uint8Array,
  encodedProof: string,
): boolean {
  const expected = Buffer.from(proof(secret, value), 'base64url');
  const actual = Buffer.from(encodedProof, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function x25519PublicKey(encoded: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error('Relay ephemeral key is invalid');
  }
  return key;
}
