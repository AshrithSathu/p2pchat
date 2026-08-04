import { randomBytes } from 'node:crypto';

import { multiaddr } from '@multiformats/multiaddr';
import { z } from 'zod';

import { describePeerIdentity } from './identity.js';

const CODE_PREFIX = 'p2pc1_';
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const invitePayloadSchema = z.object({
  version: z.literal(1),
  inviteId: base64Url.length(22),
  secret: base64Url.length(43),
  addresses: z.array(z.string().min(1).max(512)).min(1).max(16),
  creatorIdentityId: base64Url.length(43),
  creatorPublicKey: base64Url.min(40).max(128),
  creatorNetworkPeerId: z.string().min(20).max(128),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type InvitePayload = z.infer<typeof invitePayloadSchema>;

export interface CreateInviteOptions {
  readonly addresses: readonly string[];
  readonly creatorIdentityId: string;
  readonly creatorPublicKey: Uint8Array;
  readonly creatorNetworkPeerId: string;
  readonly ttlMs?: number;
  readonly now?: number;
}

export function createInvitePayload(
  options: CreateInviteOptions,
): InvitePayload {
  return invitePayloadSchema.parse({
    version: 1,
    inviteId: randomBytes(16).toString('base64url'),
    secret: randomBytes(32).toString('base64url'),
    addresses: [...options.addresses],
    creatorIdentityId: options.creatorIdentityId,
    creatorPublicKey: Buffer.from(options.creatorPublicKey).toString(
      'base64url',
    ),
    creatorNetworkPeerId: options.creatorNetworkPeerId,
    expiresAt: (options.now ?? Date.now()) + (options.ttlMs ?? 10 * 60_000),
  });
}

export function encodeInviteCode(invite: InvitePayload): string {
  const payload = Buffer.from(JSON.stringify(invite), 'utf8').toString(
    'base64url',
  );
  return `${CODE_PREFIX}${payload}`;
}

export function decodeInviteCode(
  code: string,
  now: number = Date.now(),
): InvitePayload {
  const value = code.replace(/\s/gu, '');
  if (!value.startsWith(CODE_PREFIX) || value.length > 12_000) {
    throw new Error('Invalid p2pchat invite code');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(CODE_PREFIX.length), 'base64url').toString(
        'utf8',
      ),
    );
  } catch {
    throw new Error('Invalid p2pchat invite code');
  }

  const invite = invitePayloadSchema.parse(decoded);
  if (invite.expiresAt <= now) {
    throw new Error('This invite has expired');
  }

  const identity = describePeerIdentity(
    Buffer.from(invite.creatorPublicKey, 'base64url'),
  );
  if (identity.id !== invite.creatorIdentityId) {
    throw new Error('Invite identity is inconsistent');
  }

  for (const address of invite.addresses) {
    const parsed = multiaddr(address);
    const peerId = parsed
      .getComponents()
      .findLast((component) => component.name === 'p2p')?.value;
    if (peerId !== invite.creatorNetworkPeerId) {
      throw new Error('Invite network identity is inconsistent');
    }
  }

  return invite;
}
