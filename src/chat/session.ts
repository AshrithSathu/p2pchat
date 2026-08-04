import { randomUUID } from 'node:crypto';

import type { AuthenticatedSession } from '../network/service.js';
import {
  chatFrameSchema,
  type Acknowledgement,
  type ChatMessage,
} from '../network/protocol.js';
import { prepareMessageBody } from '../security/message-body.js';
import type { LocalStore, StoredMessage } from '../storage/local-store.js';

export type ChatEvent =
  | { readonly kind: 'received'; readonly messageId: string }
  | { readonly kind: 'delivered'; readonly messageId: string }
  | { readonly kind: 'disconnected'; readonly reason: string };

export type ChatEventListener = (event: ChatEvent) => void;

export class ChatSession {
  readonly #connection: AuthenticatedSession;
  readonly #store: LocalStore;
  readonly #abortController = new AbortController();
  #writeTail: Promise<void> = Promise.resolve();
  #running = false;
  #closed = false;

  public readonly conversationId: string;

  public constructor(connection: AuthenticatedSession, store: LocalStore) {
    this.#connection = connection;
    this.#store = store;
    this.conversationId = store.ensureConversation(connection.peer);
  }

  public get peerId(): string {
    return this.#connection.peer.id;
  }

  public history(limit = 100): readonly StoredMessage[] {
    return this.#store.listMessages(this.conversationId, limit);
  }

  public async send(body: string): Promise<string> {
    this.#assertOpen();
    const safeBody = prepareMessageBody(body);
    const message: ChatMessage = {
      type: 'chat',
      version: 1,
      messageId: randomUUID(),
      sequenceNumber: this.#store.nextSequenceNumber(this.conversationId),
      sentAt: new Date().toISOString(),
      body: safeBody,
    };

    this.#store.saveOutgoingMessage({
      conversationId: this.conversationId,
      messageId: message.messageId,
      sequenceNumber: message.sequenceNumber,
      body: message.body,
      sentAt: message.sentAt,
    });
    await this.#write(message);
    this.#store.markMessageSent(message.messageId);
    return message.messageId;
  }

  public async run(listener: ChatEventListener): Promise<void> {
    this.#assertOpen();
    if (this.#running) {
      throw new Error('Chat receive loop is already running');
    }
    this.#running = true;

    try {
      while (!this.#closed) {
        const frame = await this.#connection.channel.read(
          chatFrameSchema,
          this.#abortController.signal,
        );

        if (frame.type === 'chat') {
          await this.#receiveMessage(frame, listener);
        } else {
          this.#receiveAcknowledgement(frame, listener);
        }
      }
    } catch (error: unknown) {
      if (this.#closed || this.#abortController.signal.aborted) {
        return;
      }

      const failure =
        error instanceof Error ? error : new Error('Peer disconnected');
      listener({ kind: 'disconnected', reason: failure.message });
      this.#connection.channel.abort(failure);
      throw failure;
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#abortController.abort();
    await this.#writeTail.catch(() => undefined);
    try {
      await this.#connection.channel.close();
    } catch {
      // Closing an already-ended peer stream is harmless.
    }
  }

  async #receiveMessage(
    message: ChatMessage,
    listener: ChatEventListener,
  ): Promise<void> {
    const body = prepareMessageBody(message.body);
    const receivedAt = new Date().toISOString();
    const saved = this.#store.saveIncomingMessage({
      conversationId: this.conversationId,
      messageId: message.messageId,
      senderPeerId: this.#connection.peer.id,
      sequenceNumber: message.sequenceNumber,
      body,
      sentAt: message.sentAt,
      receivedAt,
    });
    const acknowledgement: Acknowledgement = {
      type: 'ack',
      version: 1,
      messageId: message.messageId,
      receivedAt,
    };
    await this.#write(acknowledgement);
    if (saved) {
      listener({ kind: 'received', messageId: message.messageId });
    }
  }

  #receiveAcknowledgement(
    acknowledgement: Acknowledgement,
    listener: ChatEventListener,
  ): void {
    if (
      this.#store.markMessageDelivered(
        acknowledgement.messageId,
        acknowledgement.receivedAt,
      )
    ) {
      listener({
        kind: 'delivered',
        messageId: acknowledgement.messageId,
      });
    }
  }

  #write(frame: ChatMessage | Acknowledgement): Promise<void> {
    this.#assertOpen();
    const write = this.#writeTail.then(async () => {
      await this.#connection.channel.write(frame, this.#abortController.signal);
    });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Chat session is closed');
    }
  }
}
