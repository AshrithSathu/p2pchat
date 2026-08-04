import type { z } from 'zod';

import type { JsonChannel } from '../network/channel.js';

const MAX_FRAME_BYTES = 64 * 1024;

interface ReadWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class WebSocketJsonChannel implements JsonChannel {
  readonly #socket: WebSocket;
  readonly #queue: unknown[] = [];
  readonly #waiters: ReadWaiter[] = [];
  #failure: Error | null = null;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      this.#handleMessage(event);
    });
    socket.addEventListener('close', () => {
      this.#fail(new Error('Relay peer disconnected'));
    });
    socket.addEventListener('error', () => {
      this.#fail(new Error('Relay WebSocket failed'));
    });
  }

  public static async connect(
    url: URL,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<WebSocketJsonChannel> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('Unable to connect to the Internet relay'));
      };
      const onAbort = (): void => {
        cleanup();
        socket.close();
        reject(abortReason(signal));
      };
      const cleanup = (): void => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return new WebSocketJsonChannel(socket);
  }

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw abortReason(signal);
    }
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error('Relay WebSocket is not open');
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
      throw new Error('Relay protocol frame is too large');
    }
    this.#socket.send(encoded);
  }

  public async read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    const value = await this.#next(signal);
    return schema.parse(value);
  }

  public async close(): Promise<void> {
    if (
      this.#socket.readyState === WebSocket.CLOSED ||
      this.#socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#socket.addEventListener('close', () => resolve(), { once: true });
      this.#socket.close(1000, 'p2pchat closed');
    });
  }

  public abort(error: Error): void {
    this.#fail(error);
    this.#socket.close(1011, 'p2pchat aborted');
  }

  #next(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted === true) {
      return Promise.reject(abortReason(signal));
    }
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }

    return new Promise<unknown>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              const index = this.#waiters.indexOf(waiter);
              if (index >= 0) {
                this.#waiters.splice(index, 1);
              }
              reject(abortReason(signal));
            };
      const waiter: ReadWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort ?? (() => undefined), {
        once: true,
      });
    });
  }

  #handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      this.abort(new Error('Relay sent an unsupported binary frame'));
      return;
    }
    if (Buffer.byteLength(event.data, 'utf8') > MAX_FRAME_BYTES) {
      this.abort(new Error('Relay sent an oversized frame'));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      this.abort(new Error('Relay sent invalid JSON'));
      return;
    }
    if (isRelayControl(value)) {
      if (value.state === 'peer-left') {
        this.#fail(new Error('Relay peer disconnected'));
      }
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(value);
      return;
    }
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(value);
  }

  #fail(error: Error): void {
    if (this.#failure !== null) {
      return;
    }
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(error);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted');
}

function isRelayControl(value: unknown): value is {
  readonly type: 'relay-control';
  readonly version: 1;
  readonly state: 'waiting' | 'paired' | 'peer-left';
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'relay-control' &&
    'version' in value &&
    value.version === 1 &&
    'state' in value &&
    (value.state === 'waiting' ||
      value.state === 'paired' ||
      value.state === 'peer-left')
  );
}
