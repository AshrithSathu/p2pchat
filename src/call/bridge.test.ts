import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalCallBridge } from './bridge.js';
import type { TurnCredentials } from './protocol.js';

const bridges: LocalCallBridge[] = [];
const turnCredentials: TurnCredentials = {
  iceServers: [
    {
      urls: ['turn:turn.example.test:3478?transport=udp'],
      username: 'temporary-user',
      credential: 'temporary-credential',
    },
  ],
  expiresAt: Date.now() + 60_000,
};

afterEach(async () => {
  await Promise.all(
    bridges.splice(0).map(async (bridge) => await bridge.close()),
  );
});

describe('local call bridge', () => {
  it('requires its fragment token and exchanges bounded call events', async () => {
    const commands: unknown[] = [];
    const bridge = new LocalCallBridge(
      {
        callId: '6d7d2751-e49a-4f21-b844-2a96afdd552f',
        role: 'caller',
        peerLabel: 'ABCD-1234',
        turnCredentials,
      },
      (command) => {
        commands.push(command);
      },
      {
        openUrl: () => undefined,
        browserScriptPath: fileURLToPath(
          new URL('./browser-app.ts', import.meta.url),
        ),
      },
    );
    bridges.push(bridge);
    const callUrl = new URL(await bridge.open());
    const token = callUrl.hash.slice(1);
    callUrl.hash = '';

    const unauthorized = await fetch(new URL('/api/session', callUrl));
    expect(unauthorized.status).toBe(401);

    const headers = { Authorization: `Bearer ${token}` };
    const sessionResponse = await fetch(new URL('/api/session', callUrl), {
      headers,
    });
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      role: 'caller',
      peerLabel: 'ABCD-1234',
      turnCredentials,
    });

    const commandResponse = await fetch(new URL('/api/commands', callUrl), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'verified' }),
    });
    expect(commandResponse.status).toBe(202);
    expect(commands).toEqual([{ kind: 'verified' }]);

    bridge.send({ kind: 'ended', reason: 'test complete' });
    const eventResponse = await fetch(new URL('/api/events?after=0', callUrl), {
      headers,
    });
    await expect(eventResponse.json()).resolves.toEqual({
      events: [
        {
          sequence: 1,
          event: { kind: 'ended', reason: 'test complete' },
        },
      ],
    });
  });
});
