import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { describePeerIdentity } from '../network/identity.js';
import { decryptRecord, encryptRecord } from '../storage/crypto.js';
import type { LocalIdentity } from '../storage/local-store.js';

const CODE_PREFIX = 'p2pr1';
const CODE_BYTES = 15;
const CODE_CHARACTERS = 24;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_INVITE_LIFETIME_MS = 15 * 60_000;
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const relayInvitePayloadSchema = z.object({
  version: z.literal(1),
  inviteId: base64Url.length(22),
  secret: base64Url.length(43),
  creatorIdentityId: base64Url.length(43),
  creatorPublicKey: base64Url.min(40).max(128),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type RelayInvitePayload = z.infer<typeof relayInvitePayloadSchema>;

export interface RelayLocator {
  readonly code: string;
  readonly roomId: string;
  readonly creatorToken: string;
  readonly joinerToken: string;
  readonly creatorTokenHash: string;
  readonly joinerTokenHash: string;
  readonly inviteKey: Buffer;
}

export interface RelayRoomMaterial extends RelayLocator {
  readonly invite: RelayInvitePayload;
  readonly encryptedInvite: string;
}

export function isRelayInviteCode(value: string): boolean {
  try {
    decodeCode(value);
    return true;
  } catch {
    return false;
  }
}

export function createRelayRoomMaterial(
  identity: LocalIdentity,
  ttlMs = 10 * 60_000,
  now = Date.now(),
): RelayRoomMaterial {
  if (ttlMs <= 0 || ttlMs > MAX_INVITE_LIFETIME_MS) {
    throw new Error('Relay invite lifetime is invalid');
  }

  const code = formatCode(randomBytes(CODE_BYTES));
  const locator = deriveRelayLocator(code);
  const invite = relayInvitePayloadSchema.parse({
    version: 1,
    inviteId: randomBytes(16).toString('base64url'),
    secret: randomBytes(32).toString('base64url'),
    creatorIdentityId: identity.id,
    creatorPublicKey: identity.publicKey.toString('base64url'),
    expiresAt: now + ttlMs,
  });
  const encryptedInvite = encryptRecord(
    Buffer.from(JSON.stringify(invite), 'utf8'),
    locator.inviteKey,
    inviteContext(locator.roomId),
  ).toString('base64url');

  return { ...locator, invite, encryptedInvite };
}

export function deriveRelayLocator(code: string): RelayLocator {
  const codeBytes = decodeCode(code);
  const canonicalCode = formatCode(codeBytes);
  const roomId = keyedValue(codeBytes, 'room-id');
  const creatorToken = keyedValue(codeBytes, 'creator-auth');
  const joinerToken = keyedValue(codeBytes, 'joiner-auth');
  const inviteKey = Buffer.from(
    hkdfSync(
      'sha256',
      codeBytes,
      Buffer.from('p2pchat-relay-code-v1', 'utf8'),
      Buffer.from('encrypted-invite', 'utf8'),
      32,
    ),
  );

  return {
    code: canonicalCode,
    roomId,
    creatorToken,
    joinerToken,
    creatorTokenHash: hashToken(creatorToken),
    joinerTokenHash: hashToken(joinerToken),
    inviteKey,
  };
}

export function decryptRelayInvite(
  locator: RelayLocator,
  encryptedInvite: string,
  now = Date.now(),
): RelayInvitePayload {
  let decoded: unknown;
  try {
    const encryptedBytes = Buffer.from(encryptedInvite, 'base64url');
    if (encryptedBytes.toString('base64url') !== encryptedInvite) {
      throw new Error('Internet invite encoding is not canonical');
    }
    decoded = JSON.parse(
      decryptRecord(
        encryptedBytes,
        locator.inviteKey,
        inviteContext(locator.roomId),
      ).toString('utf8'),
    );
  } catch {
    throw new Error('The Internet invite code is invalid');
  }

  const invite = relayInvitePayloadSchema.parse(decoded);
  if (invite.expiresAt <= now) {
    throw new Error('This Internet invite has expired');
  }
  const creator = describePeerIdentity(
    Buffer.from(invite.creatorPublicKey, 'base64url'),
  );
  if (creator.id !== invite.creatorIdentityId) {
    throw new Error('Internet invite identity is inconsistent');
  }
  return invite;
}

function keyedValue(key: Uint8Array, label: string): string {
  return createHmac('sha256', key)
    .update(`p2pchat-relay-${label}-v1`, 'utf8')
    .digest('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function inviteContext(roomId: string): string {
  return `relay-invite:${roomId}:v1`;
}

function formatCode(bytes: Uint8Array): string {
  const encoded = encodeBase32(bytes);
  const groups = encoded.match(/.{1,4}/gu);
  if (groups === null) {
    throw new Error('Unable to format relay invite code');
  }
  return `${CODE_PREFIX}-${groups.join('-')}`;
}

function decodeCode(value: string): Buffer {
  let normalized = value.toUpperCase().replace(/[\s-]/gu, '');
  if (!normalized.startsWith(CODE_PREFIX.toUpperCase())) {
    throw new Error('Invalid Internet invite code');
  }
  normalized = normalized.slice(CODE_PREFIX.length);
  if (normalized.length !== CODE_CHARACTERS) {
    throw new Error('Invalid Internet invite code');
  }

  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error('Invalid Internet invite code');
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits !== 0 || output.length !== CODE_BYTES) {
    throw new Error('Invalid Internet invite code');
  }
  return Buffer.from(output);
}

function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabetCharacter((accumulator >>> bits) & 31);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits !== 0) {
    output += alphabetCharacter((accumulator << (5 - bits)) & 31);
  }
  return output;
}

function alphabetCharacter(index: number): string {
  const character = ALPHABET[index];
  if (character === undefined) {
    throw new Error('Unable to encode relay invite code');
  }
  return character;
}
