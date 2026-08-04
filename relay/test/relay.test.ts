import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ticketResponseSchema = z.object({
  status: z.literal('ok'),
  ticket: z.string(),
  expiresAt: z.number(),
});
const SELF = exports.default;

describe('p2pchat relay', () => {
  it('protects an opaque invite and forwards WebSocket frames', async () => {
    const roomId = await hash(randomToken());
    const creatorToken = randomToken();
    const joinerToken = randomToken();
    const encryptedInvite = randomToken().repeat(2);
    const expiresAt = Date.now() + 60_000;

    const createResponse = await SELF.fetch(
      `https://relay.test/v1/rooms/${roomId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          encryptedInvite,
          expiresAt,
          creatorTokenHash: await hash(creatorToken),
          joinerTokenHash: await hash(joinerToken),
        }),
      },
    );
    expect(createResponse.status).toBe(201);

    const forbidden = await SELF.fetch(
      `https://relay.test/v1/rooms/${roomId}/invite`,
      { headers: { Authorization: `Bearer ${randomToken()}` } },
    );
    expect(forbidden.status).toBe(403);

    const inviteResponse = await SELF.fetch(
      `https://relay.test/v1/rooms/${roomId}/invite`,
      { headers: { Authorization: `Bearer ${joinerToken}` } },
    );
    expect(inviteResponse.status).toBe(200);
    await expect(inviteResponse.json()).resolves.toMatchObject({
      encryptedInvite,
      expiresAt,
    });

    const [creatorTicket, joinerTicket] = await Promise.all([
      issueTicket(roomId, 'creator', creatorToken),
      issueTicket(roomId, 'joiner', joinerToken),
    ]);
    const creatorSocket = await connect(roomId, creatorTicket);
    const joinerSocket = await connect(roomId, joinerTicket);

    const received = nextApplicationMessage(joinerSocket);
    creatorSocket.send('opaque-e2e-ciphertext');
    await expect(received).resolves.toBe('opaque-e2e-ciphertext');

    creatorSocket.close(1000, 'test complete');
    joinerSocket.close(1000, 'test complete');
  });
});

async function issueTicket(
  roomId: string,
  role: 'creator' | 'joiner',
  token: string,
): Promise<string> {
  const response = await SELF.fetch(
    `https://relay.test/v1/rooms/${roomId}/ticket`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version: 1, role }),
    },
  );
  expect(response.status).toBe(200);
  return ticketResponseSchema.parse(await response.json()).ticket;
}

async function connect(roomId: string, ticket: string): Promise<WebSocket> {
  const response = await SELF.fetch(
    `https://relay.test/v1/rooms/${roomId}/connect?ticket=${ticket}`,
    { headers: { Upgrade: 'websocket' } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error('Relay did not return a WebSocket');
  }
  socket.accept();
  return socket;
}

function nextApplicationMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (
        typeof event.data === 'string' &&
        !event.data.includes('"relay-control"')
      ) {
        socket.removeEventListener('message', onMessage);
        resolve(event.data);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', () => {
      reject(new Error('Relay WebSocket failed'));
    });
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
