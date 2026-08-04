import { z } from 'zod';

import type { RelayLocator, RelayRoomMaterial } from './invite.js';
import { WebSocketJsonChannel } from './websocket-channel.js';

const createRoomResponseSchema = z.object({
  status: z.enum(['created', 'exists']),
  expiresAt: z.number(),
});
const inviteResponseSchema = z.object({
  status: z.literal('ok'),
  encryptedInvite: z.string(),
  expiresAt: z.number(),
});
const ticketResponseSchema = z.object({
  status: z.literal('ok'),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: z.number(),
});

export type RelayRole = 'creator' | 'joiner';

export class RelayApiClient {
  readonly #baseUrl: URL;

  public constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    const localDevelopment =
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !localDevelopment) {
      throw new Error('Internet relay URL must use HTTPS');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    parsed.search = '';
    parsed.hash = '';
    this.#baseUrl = parsed;
  }

  public async createRoom(material: RelayRoomMaterial): Promise<void> {
    await this.#request(
      `/v1/rooms/${material.roomId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          encryptedInvite: material.encryptedInvite,
          expiresAt: material.invite.expiresAt,
          creatorTokenHash: material.creatorTokenHash,
          joinerTokenHash: material.joinerTokenHash,
        }),
      },
      createRoomResponseSchema,
    );
  }

  public async fetchEncryptedInvite(locator: RelayLocator): Promise<string> {
    const response = await this.#request(
      `/v1/rooms/${locator.roomId}/invite`,
      { headers: { Authorization: `Bearer ${locator.joinerToken}` } },
      inviteResponseSchema,
    );
    return response.encryptedInvite;
  }

  public async connect(
    role: RelayRole,
    locator: RelayLocator,
  ): Promise<WebSocketJsonChannel> {
    const token =
      role === 'creator' ? locator.creatorToken : locator.joinerToken;
    const ticket = await this.#request(
      `/v1/rooms/${locator.roomId}/ticket`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ version: 1, role }),
      },
      ticketResponseSchema,
    );
    const url = new URL(`/v1/rooms/${locator.roomId}/connect`, this.#baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket.ticket);
    return await WebSocketJsonChannel.connect(url);
  }

  async #request<Schema extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const response = await fetch(new URL(path, this.#baseUrl), {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Internet relay returned HTTP ${String(response.status)}`,
      );
    }
    if (!response.ok) {
      const message =
        typeof value === 'object' &&
        value !== null &&
        'error' in value &&
        typeof value.error === 'string'
          ? value.error
          : `Internet relay returned HTTP ${String(response.status)}`;
      throw new Error(message);
    }
    return schema.parse(value);
  }
}
