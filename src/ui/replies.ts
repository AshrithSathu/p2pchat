import type { SelectItem } from '@earendil-works/pi-tui';

import type { StoredMessage } from '../storage/local-store.js';

const REPLY_PREVIEW_CODE_POINTS = 72;

export function formatReplyPreview(message: StoredMessage): string {
  const body = compact(message.body);
  const value =
    message.image === null
      ? body
      : body.length === 0
        ? `image: ${message.image.filename}`
        : `image: ${message.image.filename} — ${body}`;
  return truncateCodePoints(value.length === 0 ? 'message' : value);
}

export function createReplySelectItems(
  messages: readonly StoredMessage[],
  localPeerId: string,
): SelectItem[] {
  return [...messages].reverse().map((message) => ({
    value: message.id,
    label: `${formatTime(message.sentAt)} ${
      message.senderPeerId === localPeerId ? 'you' : 'peer'
    }`,
    description: formatReplyPreview(message),
  }));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncateCodePoints(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= REPLY_PREVIEW_CODE_POINTS) {
    return value;
  }
  return `${codePoints.slice(0, REPLY_PREVIEW_CODE_POINTS - 1).join('')}…`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
