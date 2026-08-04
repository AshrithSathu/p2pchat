import { describe, expect, it } from 'vitest';

import {
  createInvitePayload,
  decodeInviteCode,
  encodeInviteCode,
} from './invite.js';
import { describePeerIdentity } from './identity.js';

const publicKey = Buffer.alloc(44, 3);
const identity = describePeerIdentity(publicKey);
const peerId = '12D3KooWQYVf7XJj7jmc9sMiLeLbVn1wN4mC2Ykq8fZp7oHxYabc';

describe('invite codes', () => {
  it('round-trips a validated, expiring invite', () => {
    const invite = createInvitePayload({
      addresses: [`/ip4/127.0.0.1/tcp/9000/p2p/${peerId}`],
      creatorIdentityId: identity.id,
      creatorPublicKey: publicKey,
      creatorNetworkPeerId: peerId,
      now: 1_000,
      ttlMs: 5_000,
    });
    const code = encodeInviteCode(invite);

    expect(decodeInviteCode(code, 2_000)).toEqual(invite);
    expect(
      decodeInviteCode(`${code.slice(0, 30)}\n${code.slice(30)}`, 2_000),
    ).toEqual(invite);
    expect(() => decodeInviteCode(code, 6_000)).toThrow('expired');
  });

  it('rejects altered identity metadata', () => {
    const invite = createInvitePayload({
      addresses: [`/ip4/127.0.0.1/tcp/9000/p2p/${peerId}`],
      creatorIdentityId: identity.id,
      creatorPublicKey: publicKey,
      creatorNetworkPeerId: peerId,
    });
    const altered = encodeInviteCode({
      ...invite,
      creatorIdentityId: Buffer.alloc(32, 9).toString('base64url'),
    });

    expect(() => decodeInviteCode(altered)).toThrow('inconsistent');
  });
});
