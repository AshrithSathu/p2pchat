import {
  createRoomSchema,
  roomIdSchema,
  ticketRequestSchema,
} from './schema.js';
import { installerResponse, landingPageResponse } from './installer.js';
import type { RelayRoom } from './room.js';

export { RelayRoom } from './room.js';

const MAX_REQUEST_BYTES = 20 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        JSON.stringify({
          event: 'relay_request_failed',
          method: request.method,
          error: message,
        }),
      );
      return json({ error: 'Internal relay error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '' || /^\/+$/u.test(url.pathname)) {
    return landingPageResponse(request.method);
  }
  if (url.pathname === '/install.sh') {
    return installerResponse(request.method);
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ status: 'ok', service: 'p2pchat-relay', version: 1 });
  }

  const match = /^\/v1\/rooms\/([^/]+)(?:\/(invite|ticket|connect))?$/u.exec(
    url.pathname,
  );
  if (match === null) {
    return json({ error: 'Not found' }, 404);
  }
  const roomId = match[1];
  const action = match[2];
  if (roomId === undefined || !roomIdSchema.safeParse(roomId).success) {
    return json({ error: 'Invalid room identifier' }, 400);
  }

  const room = env.RELAY_ROOMS.getByName(roomId);
  if (request.method === 'PUT' && action === undefined) {
    const body = createRoomSchema.safeParse(await readBoundedJson(request));
    if (!body.success) {
      return json({ error: 'Invalid room request' }, 400);
    }
    const result = await room.createRoom(body.data);
    switch (result.status) {
      case 'created':
        return json(result, 201);
      case 'exists':
        return json(result, 200);
      case 'invalid_expiry':
        return json({ error: 'Invalid room expiry' }, 400);
      case 'conflict':
        return json({ error: 'Room identifier conflict' }, 409);
    }
  }

  if (request.method === 'GET' && action === 'invite') {
    const token = bearerToken(request);
    if (token === null) {
      return json({ error: 'Authentication required' }, 401);
    }
    const result = await room.getInvite(token);
    return relayResult(result);
  }

  if (request.method === 'POST' && action === 'ticket') {
    const token = bearerToken(request);
    if (token === null) {
      return json({ error: 'Authentication required' }, 401);
    }
    const body = ticketRequestSchema.safeParse(await readBoundedJson(request));
    if (!body.success) {
      return json({ error: 'Invalid ticket request' }, 400);
    }
    const result = await room.issueTicket(body.data.role, token);
    return relayResult(result);
  }

  if (request.method === 'GET' && action === 'connect') {
    return await room.fetch(request);
  }

  return json({ error: 'Method not allowed' }, 405);
}

function relayResult(
  result:
    | Awaited<ReturnType<RelayRoom['getInvite']>>
    | Awaited<ReturnType<RelayRoom['issueTicket']>>,
): Response {
  switch (result.status) {
    case 'ok':
      return json(result);
    case 'forbidden':
      return json({ error: 'Relay authentication failed' }, 403);
    case 'missing':
      return json({ error: 'Relay room not found' }, 404);
    case 'expired':
      return json({ error: 'Relay room expired' }, 410);
    case 'used':
      return json({ error: 'Relay invite was already used' }, 409);
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('Content-Length');
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > MAX_REQUEST_BYTES
  ) {
    throw new Error('Request body is too large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new Error('Request body is too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
