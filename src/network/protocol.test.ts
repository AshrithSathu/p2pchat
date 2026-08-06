import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { expectedImageChunkCount, MAX_IMAGE_BYTES } from '../image/image.js';
import { imageChunkSchema, imageMessageSchema } from './protocol.js';

describe('image protocol', () => {
  it('accepts bounded image metadata with an exact chunk count', () => {
    const byteLength = 30 * 1024;
    expect(
      imageMessageSchema.parse({
        type: 'image',
        version: 1,
        messageId: randomUUID(),
        sequenceNumber: 0,
        sentAt: new Date().toISOString(),
        body: '',
        attachmentId: randomUUID(),
        filename: 'picture.png',
        mimeType: 'image/png',
        byteLength,
        sha256: Buffer.alloc(32).toString('base64url'),
        chunkCount: expectedImageChunkCount(byteLength),
      }),
    ).toEqual(expect.objectContaining({ byteLength }));
  });

  it('rejects oversized metadata, wrong chunk counts, and oversized chunks', () => {
    const base = {
      type: 'image' as const,
      version: 1 as const,
      messageId: randomUUID(),
      sequenceNumber: 0,
      sentAt: new Date().toISOString(),
      body: '',
      attachmentId: randomUUID(),
      filename: 'picture.png',
      mimeType: 'image/png' as const,
      byteLength: MAX_IMAGE_BYTES,
      sha256: Buffer.alloc(32).toString('base64url'),
      chunkCount: expectedImageChunkCount(MAX_IMAGE_BYTES),
    };
    expect(() =>
      imageMessageSchema.parse({
        ...base,
        byteLength: MAX_IMAGE_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      imageMessageSchema.parse({ ...base, chunkCount: base.chunkCount - 1 }),
    ).toThrow();
    expect(() =>
      imageChunkSchema.parse({
        type: 'image-chunk',
        version: 1,
        messageId: base.messageId,
        attachmentId: base.attachmentId,
        index: 0,
        data: 'A'.repeat(17_001),
      }),
    ).toThrow();
  });
});
