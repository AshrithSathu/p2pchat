import { describe, expect, it, vi } from 'vitest';

import type { TurnCredentials } from '../call/protocol.js';
import { requestTurnCredentialsWithPeerRetry } from './service.js';
import type { RelayPeerOfflineError } from './service.js';

const credentials: TurnCredentials = {
  iceServers: [
    {
      urls: ['turn:turn.example.test:3478?transport=udp'],
      username: 'temporary-user',
      credential: 'temporary-credential',
    },
  ],
  expiresAt: Date.now() + 60_000,
};

describe('TURN credential peer presence retry', () => {
  it('recovers when the relay briefly reports the peer as missing', async () => {
    const request = vi
      .fn<() => Promise<TurnCredentials>>()
      .mockRejectedValueOnce(new Error('Relay peer is not connected'))
      .mockRejectedValueOnce(new Error('Relay peer is not connected'))
      .mockResolvedValue(credentials);

    await expect(
      requestTurnCredentialsWithPeerRetry(request, [0, 0, 0]),
    ).resolves.toBe(credentials);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('reports a typed offline error after the peer remains absent', async () => {
    const relayError = new Error('Relay peer is not connected');
    const request = vi
      .fn<() => Promise<TurnCredentials>>()
      .mockRejectedValue(relayError);

    await expect(
      requestTurnCredentialsWithPeerRetry(request, [0, 0, 0]),
    ).rejects.toMatchObject({
      name: 'RelayPeerOfflineError',
      message: 'Peer is no longer connected',
      cause: relayError,
    } satisfies Partial<RelayPeerOfflineError>);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated relay failures', async () => {
    const request = vi
      .fn<() => Promise<TurnCredentials>>()
      .mockRejectedValue(new Error('Relay authentication failed'));

    await expect(
      requestTurnCredentialsWithPeerRetry(request, [0, 0, 0]),
    ).rejects.toThrow('Relay authentication failed');
    expect(request).toHaveBeenCalledOnce();
  });
});
