import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { TurnCredentials } from './protocol.js';

const MAX_COMMAND_BYTES = 24 * 1024;
const browserCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('description'),
    description: z.object({
      type: z.enum(['offer', 'answer']),
      sdp: z.string().min(1).max(18_000),
    }),
  }),
  z.object({ kind: z.literal('verified') }),
  z.object({ kind: z.literal('hangup') }),
  z.object({
    kind: z.literal('failure'),
    reason: z.string().min(1).max(500),
  }),
]);

export type BrowserCallCommand = z.infer<typeof browserCommandSchema>;

export type BrowserCallEvent =
  | Readonly<{
      kind: 'remote-description';
      description: Readonly<{ type: 'offer' | 'answer'; sdp: string }>;
    }>
  | Readonly<{ kind: 'ended'; reason: string }>;

export interface LocalCallSession {
  readonly callId: string;
  readonly role: 'caller' | 'callee';
  readonly peerLabel: string;
  readonly turnCredentials: TurnCredentials;
  readonly remoteOfferSdp?: string;
}

export interface LocalCallBridgeOptions {
  readonly openUrl?: (url: string) => void;
  readonly browserScriptPath?: string;
}

interface SequencedBrowserEvent {
  readonly sequence: number;
  readonly event: BrowserCallEvent;
}

export class LocalCallBridge {
  readonly #session: LocalCallSession;
  readonly #token = randomBytes(32).toString('base64url');
  readonly #onCommand: (command: BrowserCallCommand) => void | Promise<void>;
  readonly #openUrl: (url: string) => void;
  readonly #browserScriptPath: string;
  readonly #events: SequencedBrowserEvent[] = [];
  #nextSequence = 1;
  #server: ReturnType<typeof createServer> | null = null;

  public constructor(
    session: LocalCallSession,
    onCommand: (command: BrowserCallCommand) => void | Promise<void>,
    options: LocalCallBridgeOptions = {},
  ) {
    this.#session = session;
    this.#onCommand = onCommand;
    this.#openUrl = options.openUrl ?? openBrowser;
    this.#browserScriptPath =
      options.browserScriptPath ?? resolveBrowserScriptPath();
  }

  public async open(): Promise<string> {
    if (this.#server !== null) {
      throw new Error('Call window is already open');
    }
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendJson(response, 500, { error: 'Local call bridge failed' });
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await this.close();
      throw new Error('Unable to determine local call window address');
    }
    const url = `http://127.0.0.1:${String(address.port)}/#${this.#token}`;
    try {
      this.#openUrl(url);
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
    return url;
  }

  public send(event: BrowserCallEvent): void {
    this.#events.push({ sequence: this.#nextSequence, event });
    this.#nextSequence += 1;
    if (this.#events.length > 64) {
      this.#events.splice(0, this.#events.length - 64);
    }
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
          "img-src 'self' blob: data:; media-src blob:; connect-src 'self'; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(CALL_HTML);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      const script = await readFile(this.#browserScriptPath);
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      response.end(script);
      return;
    }
    if (!this.#isAuthorized(request)) {
      sendJson(response, 401, { error: 'Local call authorization failed' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      sendJson(response, 200, this.#session);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
      const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
      sendJson(response, 200, {
        events: this.#events.filter((item) => item.sequence > safeAfter),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/commands') {
      const command = browserCommandSchema.parse(
        await readBoundedJson(request, MAX_COMMAND_BYTES),
      );
      await this.#onCommand(command);
      sendJson(response, 202, { status: 'accepted' });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  #isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return false;
    }
    const supplied = authorization.slice('Bearer '.length);
    const actual = Buffer.from(supplied, 'utf8');
    const expected = Buffer.from(this.#token, 'utf8');
    return (
      actual.byteLength === expected.byteLength &&
      timingSafeBufferEqual(actual, expected)
    );
  }
}

function timingSafeBufferEqual(first: Buffer, second: Buffer): boolean {
  let difference = 0;
  for (let index = 0; index < first.byteLength; index += 1) {
    difference |= (first[index] ?? 0) ^ (second[index] ?? 0);
  }
  return difference === 0;
}

async function readBoundedJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request as AsyncIterable<unknown>) {
    const chunk = requestChunk(value);
    length += chunk.byteLength;
    if (length > limit) {
      throw new Error('Local call command is too large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks, length).toString('utf8'),
    ) as unknown;
  } catch {
    throw new Error('Local call command is not valid JSON');
  }
}

function requestChunk(value: unknown): Buffer {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('Local call command has an invalid body');
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function resolveBrowserScriptPath(): string {
  const besideModule = fileURLToPath(
    new URL('./browser-app.js', import.meta.url),
  );
  if (existsSync(besideModule)) {
    return besideModule;
  }
  const developmentBuild = fileURLToPath(
    new URL('../../dist/call/browser-app.js', import.meta.url),
  );
  if (existsSync(developmentBuild)) {
    return developmentBuild;
  }
  throw new Error(
    'Video call browser assets are missing. Run pnpm build:call and restart p2pchat.',
  );
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? { executable: 'open', arguments: [url] }
      : process.platform === 'win32'
        ? {
            executable: 'cmd',
            arguments: ['/d', '/s', '/c', 'start', '', url],
          }
        : { executable: 'xdg-open', arguments: [url] };
  const child = spawn(command.executable, command.arguments, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

const CALL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>p2pchat private call</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #080a08; color: #eef2e8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 50% 0%, #172013, #080a08 48%); }
    main { width: min(1100px, 100vw); min-height: 100vh; padding: 24px; display: grid; grid-template-rows: auto 1fr auto; gap: 18px; }
    header, footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .brand { font-weight: 800; letter-spacing: -.04em; }
    .badge { color: #c7ff45; border: 1px solid #4e6721; background: #11180c; padding: 7px 10px; font-size: 12px; }
    .stage { position: relative; min-height: 480px; overflow: hidden; border: 1px solid #293027; background: #050605; }
    video { width: 100%; height: 100%; object-fit: cover; background: #050605; }
    #remote { opacity: 0; transition: opacity .25s ease; }
    #remote.visible { opacity: 1; }
    #local { position: absolute; right: 18px; bottom: 18px; width: min(28%, 260px); height: auto; aspect-ratio: 4/3; border: 1px solid #5c6955; box-shadow: 0 18px 50px #000a; }
    .status { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; text-align: center; padding: 24px; }
    .status span { padding: 10px 14px; background: #080a08dc; border: 1px solid #293027; color: #b9c1b4; }
    .controls { display: flex; gap: 10px; }
    button { appearance: none; border: 1px solid #3a4336; background: #11140f; color: #eef2e8; padding: 11px 16px; font: inherit; cursor: pointer; }
    button:hover { border-color: #c7ff45; }
    button.danger { color: #ffb4a8; border-color: #66362e; }
    .peer { color: #9da795; font-size: 12px; }
    @media (max-width: 700px) { main { padding: 12px; } .stage { min-height: 68vh; } header { align-items: flex-start; flex-direction: column; } footer { align-items: stretch; flex-direction: column; } .controls { display: grid; grid-template-columns: 1fr 1fr 1fr; } }
  </style>
</head>
<body>
  <main>
    <header><div><div class="brand">p2p/chat</div><div id="peer" class="peer">private call</div></div><div id="security" class="badge">establishing TURN relay…</div></header>
    <section class="stage"><video id="remote" autoplay playsinline></video><video id="local" autoplay playsinline muted></video><div id="status" class="status"><span>requesting camera and microphone…</span></div></section>
    <footer><div class="peer">Media is ephemeral and never stored by p2pchat.</div><div class="controls"><button id="mute" type="button">mute</button><button id="camera" type="button">camera off</button><button id="hangup" class="danger" type="button">end call</button></div></footer>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
