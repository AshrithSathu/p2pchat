import { randomUUID } from 'node:crypto';

import { VIDEO_CALL_FEATURE, type CallFrame } from '../call/protocol.js';
import {
  expectedImageChunkCount,
  IMAGE_CHUNK_BYTES,
  IMAGE_TRANSFER_FEATURE,
  prepareImage,
  type PreparedImage,
} from '../image/image.js';
import type { AuthenticatedSession } from '../network/service.js';
import {
  chatFrameSchema,
  type Acknowledgement,
  type ChatFrame,
  type ChatMessage,
  type ImageChunk,
  type ImageMessage,
} from '../network/protocol.js';
import { prepareMessageBody } from '../security/message-body.js';
import type { LocalStore, StoredMessage } from '../storage/local-store.js';

export type ChatEvent =
  | { readonly kind: 'received'; readonly messageId: string }
  | { readonly kind: 'delivered'; readonly messageId: string }
  | { readonly kind: 'call-signal'; readonly frame: CallFrame }
  | { readonly kind: 'disconnected'; readonly reason: string };

export type ChatEventListener = (event: ChatEvent) => void;

interface IncomingImageTransfer {
  readonly message: ImageMessage;
  readonly chunks: (Buffer | undefined)[];
  receivedBytes: number;
}

const MAX_PENDING_IMAGE_TRANSFERS = 4;

export class ChatSession {
  readonly #connection: AuthenticatedSession;
  readonly #store: LocalStore;
  readonly #abortController = new AbortController();
  #writeTail: Promise<void> = Promise.resolve();
  #running = false;
  #closed = false;
  readonly #incomingImages = new Map<string, IncomingImageTransfer>();

  public readonly conversationId: string;

  public constructor(connection: AuthenticatedSession, store: LocalStore) {
    this.#connection = connection;
    this.#store = store;
    this.conversationId = store.ensureConversation(connection.peer);
  }

  public get peerId(): string {
    return this.#connection.peer.id;
  }

  public get supportsImages(): boolean {
    return this.#connection.remoteFeatures.includes(IMAGE_TRANSFER_FEATURE);
  }

  public get supportsVideoCalls(): boolean {
    return (
      this.#connection.transport === 'relay' &&
      this.#connection.remoteFeatures.includes(VIDEO_CALL_FEATURE)
    );
  }

  public history(limit = 100): readonly StoredMessage[] {
    return this.#store.listMessages(this.conversationId, limit);
  }

  public message(messageId: string): StoredMessage | null {
    return this.#store.getMessage(this.conversationId, messageId);
  }

  public async send(
    body: string,
    replyToMessageId: string | null = null,
  ): Promise<string> {
    this.#assertOpen();
    const safeBody = prepareMessageBody(body);
    const message: ChatMessage = {
      type: 'chat',
      version: 1,
      messageId: randomUUID(),
      sequenceNumber: this.#store.nextSequenceNumber(this.conversationId),
      sentAt: new Date().toISOString(),
      body: safeBody,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
    };

    this.#store.saveOutgoingMessage({
      conversationId: this.conversationId,
      messageId: message.messageId,
      sequenceNumber: message.sequenceNumber,
      body: message.body,
      sentAt: message.sentAt,
      replyToMessageId,
    });
    await this.#write(message);
    this.#store.markMessageSent(message.messageId);
    return message.messageId;
  }

  public async sendImage(
    image: PreparedImage,
    body = '',
    replyToMessageId: string | null = null,
  ): Promise<string> {
    this.#assertOpen();
    if (!this.supportsImages) {
      throw new Error(
        'This peer is using an older p2pchat version without image support',
      );
    }

    const safeBody = prepareOptionalMessageBody(body);
    const safeImage = prepareImage(image.bytes, image.filename);
    const messageId = randomUUID();
    const attachmentId = randomUUID();
    const message: ImageMessage = {
      type: 'image',
      version: 1,
      messageId,
      sequenceNumber: this.#store.nextSequenceNumber(this.conversationId),
      sentAt: new Date().toISOString(),
      body: safeBody,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
      attachmentId,
      filename: safeImage.filename,
      mimeType: safeImage.mimeType,
      byteLength: safeImage.bytes.byteLength,
      sha256: safeImage.sha256,
      chunkCount: expectedImageChunkCount(safeImage.bytes.byteLength),
    };

    try {
      this.#store.saveOutgoingImageMessage({
        conversationId: this.conversationId,
        messageId,
        sequenceNumber: message.sequenceNumber,
        body: safeBody,
        sentAt: message.sentAt,
        replyToMessageId,
        image: { ...safeImage, id: attachmentId },
      });

      await this.#write(message);
      for (let index = 0; index < message.chunkCount; index += 1) {
        const start = index * IMAGE_CHUNK_BYTES;
        const chunk: ImageChunk = {
          type: 'image-chunk',
          version: 1,
          messageId,
          attachmentId,
          index,
          data: safeImage.bytes
            .subarray(start, start + IMAGE_CHUNK_BYTES)
            .toString('base64url'),
        };
        await this.#write(chunk);
      }
      this.#store.markMessageSent(messageId);
      return messageId;
    } finally {
      safeImage.bytes.fill(0);
    }
  }

  public async sendCallSignal(frame: CallFrame): Promise<void> {
    this.#assertOpen();
    if (!this.supportsVideoCalls) {
      throw new Error(
        'This peer is using an older p2pchat version without video calls',
      );
    }
    await this.#write(frame);
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

        switch (frame.type) {
          case 'ack':
            this.#receiveAcknowledgement(frame, listener);
            break;
          case 'chat':
            await this.#receiveMessage(frame, listener);
            break;
          case 'image':
            this.#receiveImageStart(frame);
            break;
          case 'image-chunk':
            await this.#receiveImageChunk(frame, listener);
            break;
          case 'call-offer':
          case 'call-answer':
          case 'call-decline':
          case 'call-end':
            if (!this.supportsVideoCalls) {
              throw new Error(
                'Peer sent call signaling without negotiating call support',
              );
            }
            listener({ kind: 'call-signal', frame });
            break;
        }
      }
    } catch (error: unknown) {
      if (this.#closed || this.#abortController.signal.aborted) {
        return;
      }

      const failure =
        error instanceof Error ? error : new Error('Peer disconnected');
      listener({ kind: 'disconnected', reason: failure.message });
      this.#discardIncomingImages();
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
    this.#discardIncomingImages();
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
      replyToMessageId: message.replyToMessageId ?? null,
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

  #receiveImageStart(message: ImageMessage): void {
    if (!this.supportsImages) {
      throw new Error('Peer sent an image without negotiating image support');
    }
    if (this.#incomingImages.has(message.attachmentId)) {
      throw new Error('Peer reused an active image attachment identifier');
    }
    if (this.#incomingImages.size >= MAX_PENDING_IMAGE_TRANSFERS) {
      throw new Error('Peer started too many image transfers');
    }

    this.#incomingImages.set(message.attachmentId, {
      message,
      chunks: Array.from<Buffer | undefined>({
        length: message.chunkCount,
      }),
      receivedBytes: 0,
    });
  }

  async #receiveImageChunk(
    frame: ImageChunk,
    listener: ChatEventListener,
  ): Promise<void> {
    const transfer = this.#incomingImages.get(frame.attachmentId);
    if (transfer?.message.messageId !== frame.messageId) {
      throw new Error('Peer sent an image chunk without a matching transfer');
    }
    if (frame.index >= transfer.message.chunkCount) {
      throw new Error('Peer sent an out-of-range image chunk');
    }
    if (transfer.chunks[frame.index] !== undefined) {
      throw new Error('Peer sent a duplicate image chunk');
    }

    const bytes = Buffer.from(frame.data, 'base64url');
    if (bytes.toString('base64url') !== frame.data) {
      throw new Error('Peer sent a malformed image chunk');
    }
    const expectedBytes = Math.min(
      IMAGE_CHUNK_BYTES,
      transfer.message.byteLength - frame.index * IMAGE_CHUNK_BYTES,
    );
    if (bytes.byteLength !== expectedBytes) {
      throw new Error('Peer sent an incorrectly sized image chunk');
    }
    transfer.chunks[frame.index] = bytes;
    transfer.receivedBytes += bytes.byteLength;

    if (transfer.chunks.some((chunk) => chunk === undefined)) {
      return;
    }

    this.#incomingImages.delete(frame.attachmentId);
    const complete = Buffer.concat(transfer.chunks as Buffer[]);
    let image: PreparedImage;
    try {
      image = prepareImage(complete, transfer.message.filename);
    } finally {
      complete.fill(0);
    }
    if (
      transfer.receivedBytes !== transfer.message.byteLength ||
      image.bytes.byteLength !== transfer.message.byteLength ||
      image.mimeType !== transfer.message.mimeType ||
      image.sha256 !== transfer.message.sha256
    ) {
      image.bytes.fill(0);
      throw new Error('Peer image failed integrity validation');
    }

    const receivedAt = new Date().toISOString();
    const body = prepareOptionalMessageBody(transfer.message.body);
    const saved = this.#store.saveIncomingImageMessage({
      conversationId: this.conversationId,
      messageId: transfer.message.messageId,
      senderPeerId: this.#connection.peer.id,
      sequenceNumber: transfer.message.sequenceNumber,
      body,
      sentAt: transfer.message.sentAt,
      receivedAt,
      replyToMessageId: transfer.message.replyToMessageId ?? null,
      image: { ...image, id: transfer.message.attachmentId },
    });
    image.bytes.fill(0);

    const acknowledgement: Acknowledgement = {
      type: 'ack',
      version: 1,
      messageId: transfer.message.messageId,
      receivedAt,
    };
    await this.#write(acknowledgement);
    if (saved) {
      listener({
        kind: 'received',
        messageId: transfer.message.messageId,
      });
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

  #write(frame: ChatFrame): Promise<void> {
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

  #discardIncomingImages(): void {
    for (const transfer of this.#incomingImages.values()) {
      for (const chunk of transfer.chunks) {
        chunk?.fill(0);
      }
    }
    this.#incomingImages.clear();
  }
}

function prepareOptionalMessageBody(body: string): string {
  return body.trim().length === 0 ? '' : prepareMessageBody(body);
}
