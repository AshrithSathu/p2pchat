import type { Stream } from '@libp2p/interface';
import { lpStream, type LengthPrefixedStream } from '@libp2p/utils';
import { z } from 'zod';

import type { JsonChannel } from './channel.js';
import {
  expectedImageChunkCount,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
} from '../image/image.js';

const MAX_FRAME_BYTES = 64 * 1024;
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  version: z.literal(1),
  inviteId: base64Url.length(22),
  identityId: base64Url.length(43),
  publicKey: base64Url.min(40).max(128),
  networkPeerId: z.string().min(20).max(128),
  nonce: base64Url.length(22),
  proof: base64Url.length(43),
  signature: base64Url.min(80).max(128),
});

export const acceptMessageSchema = z.object({
  type: z.literal('accept'),
  version: z.literal(1),
  inviteId: base64Url.length(22),
  creatorIdentityId: base64Url.length(43),
  creatorNetworkPeerId: z.string().min(20).max(128),
  nonce: base64Url.length(22),
  proof: base64Url.length(43),
  signature: base64Url.min(80).max(128),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['auth_failed', 'expired', 'invite_unavailable', 'protocol']),
  message: z.string().min(1).max(200),
});

export const handshakeResponseSchema = z.discriminatedUnion('type', [
  acceptMessageSchema,
  errorMessageSchema,
]);

export const chatMessageSchema = z.object({
  type: z.literal('chat'),
  version: z.literal(1),
  messageId: z.uuid(),
  sequenceNumber: z.number().int().nonnegative(),
  sentAt: z.iso.datetime(),
  body: z.string().min(1).max(16_384),
  replyToMessageId: z.uuid().optional(),
});

export const acknowledgementSchema = z.object({
  type: z.literal('ack'),
  version: z.literal(1),
  messageId: z.uuid(),
  receivedAt: z.iso.datetime(),
});

export const imageMessageSchema = z
  .object({
    type: z.literal('image'),
    version: z.literal(1),
    messageId: z.uuid(),
    sequenceNumber: z.number().int().nonnegative(),
    sentAt: z.iso.datetime(),
    body: z.string().max(16_384),
    replyToMessageId: z.uuid().optional(),
    attachmentId: z.uuid(),
    filename: z.string().min(1).max(160),
    mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
    byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
    sha256: base64Url.length(43),
    chunkCount: z.number().int().positive().max(512),
  })
  .refine(
    (message) =>
      message.chunkCount === expectedImageChunkCount(message.byteLength),
    { message: 'Image chunk count does not match its byte length' },
  );

export const imageChunkSchema = z.object({
  type: z.literal('image-chunk'),
  version: z.literal(1),
  messageId: z.uuid(),
  attachmentId: z.uuid(),
  index: z.number().int().nonnegative().max(511),
  data: base64Url.min(1).max(17_000),
});

export const chatFrameSchema = z.discriminatedUnion('type', [
  chatMessageSchema,
  imageMessageSchema,
  imageChunkSchema,
  acknowledgementSchema,
]);

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type AcceptMessage = z.infer<typeof acceptMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
export type ImageMessage = z.infer<typeof imageMessageSchema>;
export type ImageChunk = z.infer<typeof imageChunkSchema>;
export type ChatFrame = z.infer<typeof chatFrameSchema>;

export class FrameChannel implements JsonChannel {
  readonly #stream: Stream;
  readonly #framed: LengthPrefixedStream<Stream>;

  public constructor(stream: Stream) {
    stream.maxReadBufferLength = MAX_FRAME_BYTES * 2;
    stream.maxWriteBufferLength = MAX_FRAME_BYTES * 2;
    this.#stream = stream;
    this.#framed = lpStream(stream, {
      maxDataLength: MAX_FRAME_BYTES,
      maxBufferSize: MAX_FRAME_BYTES * 2,
    });
  }

  public async write(value: unknown, signal?: AbortSignal): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(value), 'utf8');
    if (encoded.byteLength > MAX_FRAME_BYTES) {
      throw new Error('Protocol frame is too large');
    }

    await this.#framed.write(encoded, signal === undefined ? {} : { signal });
  }

  public async read<Schema extends z.ZodType>(
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    const encoded = await this.#framed.read(
      signal === undefined ? {} : { signal },
    );
    let decoded: unknown;

    try {
      decoded = JSON.parse(Buffer.from(encoded.subarray()).toString('utf8'));
    } catch {
      throw new Error('Peer sent invalid JSON');
    }

    return schema.parse(decoded);
  }

  public async close(): Promise<void> {
    await this.#stream.close();
  }

  public abort(error: Error): void {
    this.#stream.abort(error);
  }
}
