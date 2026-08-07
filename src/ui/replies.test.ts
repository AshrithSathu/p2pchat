import { describe, expect, it } from 'vitest';

import type { StoredMessage } from '../storage/local-store.js';
import { createReplySelectItems, formatReplyPreview } from './replies.js';

const baseMessage: StoredMessage = {
  id: 'b72d746d-9d59-4b09-8df0-231656b54ce5',
  conversationId: 'conversation',
  senderPeerId: 'peer',
  sequenceNumber: 0,
  body: 'first line\nsecond line',
  replyToMessageId: null,
  sentAt: '2026-08-07T06:30:00.000Z',
  receivedAt: '2026-08-07T06:30:01.000Z',
  deliveryState: 'received',
  image: null,
};

describe('reply presentation', () => {
  it('creates newest-first picker items without exposing message IDs', () => {
    const newer: StoredMessage = {
      ...baseMessage,
      id: '865acb2c-1809-4a31-b7c0-205af8c1ec94',
      senderPeerId: 'self',
      sequenceNumber: 1,
      body: 'newer message',
      sentAt: '2026-08-07T06:31:00.000Z',
    };

    const items = createReplySelectItems([baseMessage, newer], 'self');

    expect(items.map((item) => item.value)).toEqual([newer.id, baseMessage.id]);
    expect(items[0]?.label).toContain('you');
    expect(items[0]?.label).not.toContain(newer.id);
    expect(items[1]?.description).toBe('first line second line');
  });

  it('summarizes image replies and bounds long previews', () => {
    const imageMessage: StoredMessage = {
      ...baseMessage,
      body: 'private screenshot',
      image: {
        id: 'attachment',
        filename: 'screen.png',
        mimeType: 'image/png',
        byteLength: 42,
      },
    };

    expect(formatReplyPreview(imageMessage)).toBe(
      'image: screen.png — private screenshot',
    );
    expect(
      Array.from(formatReplyPreview({ ...baseMessage, body: 'x'.repeat(100) })),
    ).toHaveLength(72);
  });
});
