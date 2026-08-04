import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type { LocalStore } from '../storage/local-store.js';
import { describePeerIdentity } from './identity.js';
import type { InvitePayload } from './invite.js';
import type { AcceptMessage, JoinMessage } from './protocol.js';

function lengthPrefix(value: Uint8Array): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(value.byteLength);
  return Buffer.concat([prefix, value]);
}

function transcript(parts: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(
    parts.map((part) =>
      lengthPrefix(typeof part === 'string' ? Buffer.from(part, 'utf8') : part),
    ),
  );
}

export function createJoinTranscript(
  invite: InvitePayload,
  joinerIdentityId: string,
  joinerPublicKey: Uint8Array,
  joinerNetworkPeerId: string,
  nonce: string,
): Buffer {
  return transcript([
    'p2pchat-join-v1',
    invite.inviteId,
    invite.creatorIdentityId,
    invite.creatorNetworkPeerId,
    joinerIdentityId,
    joinerPublicKey,
    joinerNetworkPeerId,
    nonce,
  ]);
}

export function createAcceptTranscript(
  joinTranscript: Uint8Array,
  creatorNonce: string,
): Buffer {
  return transcript([
    'p2pchat-accept-v1',
    createHash('sha256').update(joinTranscript).digest(),
    creatorNonce,
  ]);
}

function proof(secret: string, value: Uint8Array): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(value)
    .digest('base64url');
}

export function verifyProof(
  secret: string,
  value: Uint8Array,
  encodedProof: string,
): boolean {
  const expected = Buffer.from(proof(secret, value), 'base64url');
  const actual = Buffer.from(encodedProof, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createJoinMessage(
  store: LocalStore,
  invite: InvitePayload,
  networkPeerId: string,
): JoinMessage {
  const identity = store.identity;
  const nonce = randomBytes(16).toString('base64url');
  const value = createJoinTranscript(
    invite,
    identity.id,
    identity.publicKey,
    networkPeerId,
    nonce,
  );

  return {
    type: 'join',
    version: 1,
    inviteId: invite.inviteId,
    identityId: identity.id,
    publicKey: identity.publicKey.toString('base64url'),
    networkPeerId,
    nonce,
    proof: proof(invite.secret, value),
    signature: store.sign(value).toString('base64url'),
  };
}

export function verifyJoinMessage(
  store: LocalStore,
  invite: InvitePayload,
  message: JoinMessage,
  transportPeerId: string,
): Buffer {
  if (
    message.inviteId !== invite.inviteId ||
    message.networkPeerId !== transportPeerId
  ) {
    throw new Error('Join request is not bound to this connection');
  }

  const publicKey = Buffer.from(message.publicKey, 'base64url');
  const identity = describePeerIdentity(publicKey);
  if (identity.id !== message.identityId) {
    throw new Error('Join identity is inconsistent');
  }

  const value = createJoinTranscript(
    invite,
    message.identityId,
    publicKey,
    message.networkPeerId,
    message.nonce,
  );

  if (!verifyProof(invite.secret, value, message.proof)) {
    throw new Error('Join proof is invalid');
  }

  if (
    !store.verify(publicKey, value, Buffer.from(message.signature, 'base64url'))
  ) {
    throw new Error('Join signature is invalid');
  }

  return value;
}

export function createAcceptMessage(
  store: LocalStore,
  invite: InvitePayload,
  joinTranscript: Uint8Array,
): AcceptMessage {
  const nonce = randomBytes(16).toString('base64url');
  const value = createAcceptTranscript(joinTranscript, nonce);

  return {
    type: 'accept',
    version: 1,
    inviteId: invite.inviteId,
    creatorIdentityId: invite.creatorIdentityId,
    creatorNetworkPeerId: invite.creatorNetworkPeerId,
    nonce,
    proof: proof(invite.secret, value),
    signature: store.sign(value).toString('base64url'),
  };
}

export function verifyAcceptMessage(
  store: LocalStore,
  invite: InvitePayload,
  joinTranscript: Uint8Array,
  message: AcceptMessage,
): void {
  if (
    message.inviteId !== invite.inviteId ||
    message.creatorIdentityId !== invite.creatorIdentityId ||
    message.creatorNetworkPeerId !== invite.creatorNetworkPeerId
  ) {
    throw new Error('Accept response is not bound to this invite');
  }

  const value = createAcceptTranscript(joinTranscript, message.nonce);
  if (!verifyProof(invite.secret, value, message.proof)) {
    throw new Error('Accept proof is invalid');
  }

  if (
    !store.verify(
      Buffer.from(invite.creatorPublicKey, 'base64url'),
      value,
      Buffer.from(message.signature, 'base64url'),
    )
  ) {
    throw new Error('Accept signature is invalid');
  }
}
