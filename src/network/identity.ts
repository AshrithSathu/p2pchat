import { createHash } from 'node:crypto';

export interface PeerIdentity {
  readonly id: string;
  readonly publicKey: Buffer;
  readonly fingerprint: string;
}

export function describePeerIdentity(publicKey: Uint8Array): PeerIdentity {
  const key = Buffer.from(publicKey);
  const digest = createHash('sha256').update(key).digest();
  const fingerprint = digest
    .toString('hex')
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join('-');

  if (fingerprint === undefined) {
    throw new Error('Unable to format peer identity fingerprint');
  }

  return {
    id: digest.toString('base64url'),
    publicKey: key,
    fingerprint,
  };
}

export function createSafetyNumber(
  creatorPublicKey: Uint8Array,
  joinerPublicKey: Uint8Array,
  creatorSignalIdentityKey: Uint8Array,
  joinerSignalIdentityKey: Uint8Array,
): string {
  const digest = createHash('sha256')
    .update('p2pchat-safety-number-v2\0')
    .update(creatorPublicKey)
    .update(joinerPublicKey)
    .update(creatorSignalIdentityKey)
    .update(joinerSignalIdentityKey)
    .digest();

  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(digest.readUInt16BE(offset).toString(10).padStart(5, '0'));
  }

  return groups.join(' ');
}
