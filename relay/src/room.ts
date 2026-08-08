import { DurableObject } from 'cloudflare:workers';

import {
  relayTokenSchema,
  type CreateRoomRequest,
  type RelayRole,
} from './schema.js';

const MAX_ROOM_LIFETIME_MS = 15 * 60_000;
const TICKET_LIFETIME_MS = 30_000;
const MAX_RELAY_FRAME_BYTES = 64 * 1024;
const MAX_TURN_CREDENTIAL_CLAIMS_PER_ROLE = 32;

const ROOM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    encrypted_invite TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    creator_token_hash TEXT NOT NULL,
    joiner_token_hash TEXT NOT NULL,
    paired INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('creator', 'joiner')),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turn_credential_claims (
    role TEXT NOT NULL CHECK (role IN ('creator', 'joiner')),
    call_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (role, call_id)
  );
`;

interface RoomRow extends Record<string, SqlStorageValue> {
  readonly encrypted_invite: string;
  readonly expires_at: number;
  readonly creator_token_hash: string;
  readonly joiner_token_hash: string;
  readonly paired: number;
}

interface TicketRow extends Record<string, SqlStorageValue> {
  readonly role: RelayRole;
  readonly expires_at: number;
}

interface SocketAttachment {
  readonly role: RelayRole;
}

export type CreateRoomResult =
  | { readonly status: 'created' | 'exists'; readonly expiresAt: number }
  | { readonly status: 'invalid_expiry' | 'conflict' };

export type InviteResult =
  | {
      readonly status: 'ok';
      readonly encryptedInvite: string;
      readonly expiresAt: number;
    }
  | { readonly status: 'forbidden' | 'missing' | 'expired' | 'used' };

export type TicketResult =
  | {
      readonly status: 'ok';
      readonly ticket: string;
      readonly expiresAt: number;
    }
  | { readonly status: 'forbidden' | 'missing' | 'expired' | 'used' };

export type TurnCredentialClaimResult =
  | { readonly status: 'ok' }
  | {
      readonly status:
        'forbidden' | 'missing' | 'expired' | 'not_paired' | 'limit_reached';
    };

export class RelayRoom extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(ROOM_SCHEMA);
      return Promise.resolve();
    });
  }

  public async createRoom(input: CreateRoomRequest): Promise<CreateRoomResult> {
    const now = Date.now();
    if (
      input.expiresAt <= now ||
      input.expiresAt > now + MAX_ROOM_LIFETIME_MS
    ) {
      return { status: 'invalid_expiry' };
    }

    const existing = this.#getRoom();
    if (existing !== null && existing.expires_at > now) {
      if (
        existing.encrypted_invite === input.encryptedInvite &&
        existing.creator_token_hash === input.creatorTokenHash &&
        existing.joiner_token_hash === input.joinerTokenHash
      ) {
        return { status: 'exists', expiresAt: existing.expires_at };
      }
      return { status: 'conflict' };
    }

    this.ctx.storage.sql.exec(
      'DELETE FROM turn_credential_claims; DELETE FROM tickets; DELETE FROM room;',
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO room
        (singleton, encrypted_invite, expires_at, creator_token_hash,
         joiner_token_hash)
       VALUES (1, ?, ?, ?, ?)`,
      input.encryptedInvite,
      input.expiresAt,
      input.creatorTokenHash,
      input.joinerTokenHash,
    );
    await this.ctx.storage.setAlarm(input.expiresAt);
    return { status: 'created', expiresAt: input.expiresAt };
  }

  public async getInvite(token: string): Promise<InviteResult> {
    const room = this.#getRoom();
    if (room === null) {
      return { status: 'missing' };
    }
    if (room.expires_at <= Date.now()) {
      await this.#expire();
      return { status: 'expired' };
    }
    if (room.paired === 1) {
      return { status: 'used' };
    }
    if (!(await tokenMatches(token, room.joiner_token_hash))) {
      return { status: 'forbidden' };
    }
    return {
      status: 'ok',
      encryptedInvite: room.encrypted_invite,
      expiresAt: room.expires_at,
    };
  }

  public async issueTicket(
    role: RelayRole,
    token: string,
  ): Promise<TicketResult> {
    const room = this.#getRoom();
    if (room === null) {
      return { status: 'missing' };
    }
    if (room.expires_at <= Date.now()) {
      await this.#expire();
      return { status: 'expired' };
    }
    if (room.paired === 1) {
      return { status: 'used' };
    }
    const expected =
      role === 'creator' ? room.creator_token_hash : room.joiner_token_hash;
    if (!(await tokenMatches(token, expected))) {
      return { status: 'forbidden' };
    }

    const ticketBytes = new Uint8Array(32);
    crypto.getRandomValues(ticketBytes);
    const ticket = base64UrlEncode(ticketBytes);
    const ticketHash = await hashBase64Url(ticket);
    const expiresAt = Math.min(
      Date.now() + TICKET_LIFETIME_MS,
      room.expires_at,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (ticket_hash, role, expires_at)
       VALUES (?, ?, ?)`,
      ticketHash,
      role,
      expiresAt,
    );
    return { status: 'ok', ticket, expiresAt };
  }

  public async claimTurnCredentials(
    role: RelayRole,
    token: string,
    callId: string,
  ): Promise<TurnCredentialClaimResult> {
    const room = this.#getRoom();
    if (room === null) {
      return { status: 'missing' };
    }
    if (room.expires_at <= Date.now() && room.paired === 0) {
      await this.#expire();
      return { status: 'expired' };
    }
    if (
      room.paired === 0 ||
      this.ctx.getWebSockets('creator').length !== 1 ||
      this.ctx.getWebSockets('joiner').length !== 1
    ) {
      return { status: 'not_paired' };
    }
    const expected =
      role === 'creator' ? room.creator_token_hash : room.joiner_token_hash;
    if (!(await tokenMatches(token, expected))) {
      return { status: 'forbidden' };
    }

    const prior = this.ctx.storage.sql
      .exec<{ readonly attempts: number }>(
        'SELECT attempts FROM turn_credential_claims WHERE role = ? AND call_id = ?',
        role,
        callId,
      )
      .toArray()[0];
    if (prior !== undefined) {
      if (prior.attempts >= 3) {
        return { status: 'limit_reached' };
      }
      this.ctx.storage.sql.exec(
        `UPDATE turn_credential_claims
         SET attempts = attempts + 1, issued_at = ?
         WHERE role = ? AND call_id = ?`,
        Date.now(),
        role,
        callId,
      );
      return { status: 'ok' };
    }
    const count =
      this.ctx.storage.sql
        .exec<{ readonly count: number }>(
          'SELECT COUNT(*) AS count FROM turn_credential_claims WHERE role = ?',
          role,
        )
        .toArray()[0]?.count ?? 0;
    if (count >= MAX_TURN_CREDENTIAL_CLAIMS_PER_ROLE) {
      return { status: 'limit_reached' };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO turn_credential_claims (role, call_id, issued_at, attempts)
       VALUES (?, ?, ?, 1)`,
      role,
      callId,
      Date.now(),
    );
    return { status: 'ok' };
  }

  public override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(
        { error: 'WebSocket upgrade required' },
        { status: 426 },
      );
    }

    const ticket = new URL(request.url).searchParams.get('ticket');
    if (ticket === null || !relayTokenSchema.safeParse(ticket).success) {
      return Response.json({ error: 'Invalid relay ticket' }, { status: 401 });
    }
    const ticketHash = await hashBase64Url(ticket);
    const row = this.ctx.storage.sql
      .exec<TicketRow>(
        'SELECT role, expires_at FROM tickets WHERE ticket_hash = ?',
        ticketHash,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      'DELETE FROM tickets WHERE ticket_hash = ?',
      ticketHash,
    );
    if (row === undefined || row.expires_at <= Date.now()) {
      return Response.json({ error: 'Relay ticket expired' }, { status: 401 });
    }
    if (this.ctx.getWebSockets(row.role).length !== 0) {
      return Response.json(
        { error: 'Relay role already connected' },
        { status: 409 },
      );
    }

    const pair = new WebSocketPair();
    const sockets = Object.values(pair);
    const client = sockets[0];
    const server = sockets[1];
    if (client === undefined || server === undefined) {
      throw new Error('Unable to create WebSocket pair');
    }

    this.ctx.acceptWebSocket(server, [row.role]);
    server.serializeAttachment({ role: row.role } satisfies SocketAttachment);
    const otherRole = oppositeRole(row.role);
    const other = this.ctx.getWebSockets(otherRole)[0];
    if (other === undefined) {
      sendControl(server, 'waiting');
    } else {
      this.ctx.storage.sql.exec(
        'UPDATE room SET paired = 1 WHERE singleton = 1; DELETE FROM tickets;',
      );
      await this.ctx.storage.deleteAlarm();
      sendControl(server, 'paired');
      sendControl(other, 'paired');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  public override webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    const size =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > MAX_RELAY_FRAME_BYTES) {
      socket.close(1009, 'Relay frame exceeds size limit');
      return;
    }

    const role = socketRole(socket);
    const peer = this.ctx.getWebSockets(oppositeRole(role))[0];
    if (peer === undefined) {
      sendControl(socket, 'waiting');
      return;
    }
    peer.send(message);
  }

  public override async webSocketClose(socket: WebSocket): Promise<void> {
    this.#notifyPeerLeft(socket);
    await this.#expire();
  }

  public override async webSocketError(socket: WebSocket): Promise<void> {
    this.#notifyPeerLeft(socket);
    await this.#expire();
  }

  public override async alarm(): Promise<void> {
    await this.#expire();
  }

  #getRoom(): RoomRow | null {
    return (
      this.ctx.storage.sql
        .exec<RoomRow>(
          `SELECT encrypted_invite, expires_at, creator_token_hash,
                  joiner_token_hash, paired
           FROM room WHERE singleton = 1`,
        )
        .toArray()[0] ?? null
    );
  }

  #notifyPeerLeft(socket: WebSocket): void {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      return;
    }
    for (const peer of this.ctx.getWebSockets(oppositeRole(attachment.role))) {
      sendControl(peer, 'peer-left');
    }
  }

  async #expire(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1000, 'Relay room expired');
    }
    await this.ctx.storage.deleteAll();
  }
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== 'object' || value === null || !('role' in value)) {
    return false;
  }
  return value.role === 'creator' || value.role === 'joiner';
}

function socketRole(socket: WebSocket): RelayRole {
  const attachment: unknown = socket.deserializeAttachment();
  if (!isSocketAttachment(attachment)) {
    throw new Error('Relay socket attachment is missing');
  }
  return attachment.role;
}

function oppositeRole(role: RelayRole): RelayRole {
  return role === 'creator' ? 'joiner' : 'creator';
}

function sendControl(
  socket: WebSocket,
  state: 'waiting' | 'paired' | 'peer-left',
): void {
  socket.send(JSON.stringify({ type: 'relay-control', version: 1, state }));
}

async function tokenMatches(
  token: string,
  expectedHash: string,
): Promise<boolean> {
  if (!relayTokenSchema.safeParse(token).success) {
    return false;
  }
  const actual = base64UrlDecode(await hashBase64Url(token));
  const expected = base64UrlDecode(expectedHash);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function hashBase64Url(value: string): Promise<string> {
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

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
