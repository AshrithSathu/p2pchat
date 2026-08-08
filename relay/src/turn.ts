import { z } from 'zod';

import { cloudflareTurnResponseSchema } from './schema.js';

const MAX_TURN_RESPONSE_BYTES = 32 * 1024;
const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;
const turnProviderSchema = z.enum(['cloudflare', 'coturn']);
const coturnUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.startsWith('turn:') || value.startsWith('turns:'),
    'Coturn URLs must use turn: or turns:',
  );

interface GeneratedTurnCredentials {
  readonly iceServers: readonly {
    readonly urls: readonly string[];
    readonly username: string;
    readonly credential: string;
  }[];
  readonly expiresAt: number;
}

export async function generateTurnCredentials(
  env: Env,
  callId: string,
  now: number,
): Promise<GeneratedTurnCredentials> {
  const provider = turnProviderSchema.parse(
    environmentValue(env, 'TURN_PROVIDER') ?? 'cloudflare',
  );
  return provider === 'coturn'
    ? await generateCoturnCredentials(env, callId, now)
    : await generateCloudflareCredentials(env, now);
}

async function generateCloudflareCredentials(
  env: Env,
  now: number,
): Promise<GeneratedTurnCredentials> {
  const keyId = requiredEnvironmentValue(env, 'TURN_KEY_ID');
  const apiToken = requiredEnvironmentValue(env, 'TURN_KEY_API_TOKEN');
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      keyId,
    )}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: 'turn_credential_generation_failed',
        status: response.status,
      }),
    );
    throw new Error('TURN credential provider rejected the request');
  }
  const decoded = cloudflareTurnResponseSchema.parse(
    JSON.parse(
      await readBoundedResponseText(response, MAX_TURN_RESPONSE_BYTES),
    ),
  );
  const iceServers = decoded.iceServers.flatMap((server) => {
    if (server.username === undefined || server.credential === undefined) {
      return [];
    }
    const urls = (
      typeof server.urls === 'string' ? [server.urls] : server.urls
    ).filter(isSupportedBrowserTurnUrl);
    return urls.length === 0
      ? []
      : [{ urls, username: server.username, credential: server.credential }];
  });
  if (iceServers.length === 0) {
    throw new Error('TURN credential provider returned no relay URLs');
  }
  return {
    iceServers,
    expiresAt: now + TURN_CREDENTIAL_TTL_SECONDS * 1_000,
  };
}

async function generateCoturnCredentials(
  env: Env,
  callId: string,
  now: number,
): Promise<GeneratedTurnCredentials> {
  const secret = requiredEnvironmentValue(env, 'COTURN_SHARED_SECRET');
  if (secret.length < 32 || secret.length > 512) {
    throw new Error('Coturn shared secret must contain 32-512 characters');
  }
  const urls = z
    .array(coturnUrlSchema)
    .min(1)
    .max(12)
    .parse(
      requiredEnvironmentValue(env, 'COTURN_URLS')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  const expiresAtSeconds =
    Math.floor(now / 1_000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${String(expiresAtSeconds)}:p2pchat-${callId}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(username),
  );
  const credential = bytesToBase64(new Uint8Array(signature));
  return {
    iceServers: [{ urls, username, credential }],
    expiresAt: expiresAtSeconds * 1_000,
  };
}

function isSupportedBrowserTurnUrl(value: string): boolean {
  return (
    (value.startsWith('turn:') || value.startsWith('turns:')) &&
    !/^turns?:[^/?#]+:53(?:[/?#]|$)/u.test(value)
  );
}

function environmentValue(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredEnvironmentValue(env: Env, name: string): string {
  const value = environmentValue(env, name);
  if (value === undefined) {
    throw new Error(`TURN provider environment ${name} is missing`);
  }
  return value;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function readBoundedResponseText(
  response: Response,
  limit: number,
): Promise<string> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > limit) {
    throw new Error('TURN credential response is too large');
  }
  if (response.body === null) {
    throw new Error('TURN credential response is empty');
  }
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('TURN credential response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
