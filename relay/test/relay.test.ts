import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { APP_VERSION } from '../../src/core/version.js';
import { generateTurnCredentials } from '../src/turn.js';

const ticketResponseSchema = z.object({
  status: z.literal('ok'),
  ticket: z.string(),
  expiresAt: z.number(),
});
const turnCredentialsResponseSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.array(z.string()),
      username: z.string(),
      credential: z.string(),
    }),
  ),
  expiresAt: z.number(),
});
const SELF = exports.default;
const TEST_ARCHIVE = 'test-distribution-archive';
const testRelease = {
  version: APP_VERSION,
  releasedAt: '2026-08-08T00:00:00.000Z',
  artifacts: {
    'darwin-arm64': artifact('darwin-arm64', '1'),
    'darwin-x64': artifact('darwin-x64', '2'),
    'linux-arm64': artifact('linux-arm64', '3'),
    'linux-x64': artifact('linux-x64', '4'),
  },
  source: artifact('source', '5'),
} as const;

beforeEach(async () => {
  await env.RELEASES.put('releases/latest.json', JSON.stringify(testRelease), {
    httpMetadata: { contentType: 'application/json' },
  });
  await Promise.all(
    [...Object.values(testRelease.artifacts), testRelease.source].map(
      async (releaseArtifact) => {
        await env.RELEASES.put(
          `releases/${releaseArtifact.filename}`,
          TEST_ARCHIVE,
          { httpMetadata: { contentType: 'application/gzip' } },
        );
      },
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('p2pchat relay', () => {
  it('generates standard short-lived Coturn REST credentials locally', async () => {
    const providerFetch = vi.spyOn(globalThis, 'fetch');
    const callId = '97eb393d-6815-4878-95bd-f3aff7f7a32d';
    const credentials = await generateTurnCredentials(
      {
        TURN_PROVIDER: 'coturn',
        COTURN_SHARED_SECRET:
          'local-test-secret-with-at-least-thirty-two-characters',
        COTURN_URLS:
          'turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp',
      } as unknown as Env,
      callId,
      1_800_000_000_000,
    );

    expect(credentials).toEqual({
      iceServers: [
        {
          urls: [
            'turn:127.0.0.1:3478?transport=udp',
            'turn:127.0.0.1:3478?transport=tcp',
          ],
          username: `1800014400:p2pchat-${callId}`,
          credential: 'Ln+WBLB/R8CfJJ794oCaal75onw=',
        },
      ],
      expiresAt: 1_800_014_400_000,
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('serves a version-pinned installer and human-readable landing page', async () => {
    const installer = await SELF.fetch('https://relay.test/install.sh');
    expect(installer.status).toBe(200);
    expect(installer.headers.get('Content-Type')).toContain(
      'text/x-shellscript',
    );
    expect(installer.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(installer.headers.get('X-p2pchat-Version')).toBe(APP_VERSION);
    const script = await installer.text();
    expect(script).toMatch(/^#!\/bin\/sh\nset -eu/u);
    expect(script).toContain(`version='${APP_VERSION}'`);
    expect(script).toContain("archive_sha256='1111111111111111");
    expect(script).toContain('download checksum verification failed');
    expect(script).not.toContain('npm install');
    expect(script).not.toMatch(/^\s*sudo\s/mu);

    const head = await SELF.fetch('https://relay.test/install.sh', {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const landing = await SELF.fetch('https://relay.test/');
    expect(landing.status).toBe(200);
    await expect(landing.text()).resolves.toContain(
      'curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh',
    );

    const repeatedSlashLanding = await SELF.fetch('https://relay.test//');
    expect(repeatedSlashLanding.status).toBe(200);

    const latest = await SELF.fetch('https://relay.test/downloads/latest.json');
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toEqual(testRelease);

    const artifactResponse = await SELF.fetch(
      `https://relay.test/downloads/${testRelease.artifacts['linux-x64'].filename}`,
    );
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get('Cache-Control')).toContain(
      'immutable',
    );
    await expect(artifactResponse.text()).resolves.toBe(TEST_ARCHIVE);
  });

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

    const providerFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(
          'https://rtc.live.cloudflare.com/v1/turn/keys/test-turn-key-id/credentials/generate-ice-servers',
        );
        expect(request.headers.get('Authorization')).toBe(
          'Bearer test-turn-api-token',
        );
        await expect(request.json()).resolves.toEqual({ ttl: 14_400 });
        return Response.json(
          {
            iceServers: [
              { urls: ['stun:stun.cloudflare.com:3478'] },
              {
                urls: [
                  'turn:turn.cloudflare.com:3478?transport=udp',
                  'turns:turn.cloudflare.com:5349?transport=tcp',
                ],
                username: 'short-lived-user',
                credential: 'short-lived-credential',
              },
            ],
          },
          { status: 201 },
        );
      });
    const turnResponse = await SELF.fetch(
      `https://relay.test/v1/rooms/${roomId}/turn-credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creatorToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          role: 'creator',
          callId: crypto.randomUUID(),
        }),
      },
    );
    expect(turnResponse.status).toBe(200);
    const turnCredentials = turnCredentialsResponseSchema.parse(
      await turnResponse.json(),
    );
    expect(turnCredentials.iceServers).toEqual([
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
        ],
        username: 'short-lived-user',
        credential: 'short-lived-credential',
      },
    ]);
    expect(turnCredentials.expiresAt).toBeGreaterThan(Date.now());
    expect(providerFetch).toHaveBeenCalledOnce();

    creatorSocket.close(1000, 'test complete');
    joinerSocket.close(1000, 'test complete');
  });
});

function artifact(target: string, hashDigit: string) {
  return {
    filename: `p2pchat-v${APP_VERSION}-${target}.tar.gz`,
    sha256: hashDigit.repeat(64),
    bytes: TEST_ARCHIVE.length,
  };
}

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
