import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import { getImageDimensions } from '@earendil-works/pi-tui';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 12 * 1024;
export const IMAGE_TRANSFER_FEATURE = 'image-v1' as const;
const MAX_IMAGE_DIMENSION = 8_192;
const MAX_IMAGE_PIXELS = 25_000_000;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface PreparedImage {
  readonly filename: string;
  readonly mimeType: SupportedImageMimeType;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export class InvalidImageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidImageError';
  }
}

export async function loadImageFile(path: string): Promise<PreparedImage> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new InvalidImageError('Dropped image path is not a regular file');
    }
    if (details.size === 0) {
      throw new InvalidImageError('Image is empty');
    }
    if (details.size > MAX_IMAGE_BYTES) {
      throw new InvalidImageError('Image exceeds the 2 MiB limit');
    }

    const bytes = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
    let byteLength = 0;
    while (byteLength < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        byteLength,
        bytes.byteLength - byteLength,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      byteLength += bytesRead;
    }

    return prepareImage(bytes.subarray(0, byteLength), basename(path));
  } finally {
    await handle.close();
  }
}

export function prepareImage(
  input: Uint8Array,
  filename: string,
): PreparedImage {
  const bytes = Buffer.from(input);
  if (bytes.byteLength === 0) {
    throw new InvalidImageError('Image is empty');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new InvalidImageError('Image exceeds the 2 MiB limit');
  }

  const mimeType = detectImageMimeType(bytes);
  if (mimeType === null) {
    throw new InvalidImageError(
      'Unsupported image. Use PNG, JPEG, GIF, or WebP.',
    );
  }
  const dimensions = getImageDimensions(bytes.toString('base64'), mimeType);
  if (dimensions === null) {
    throw new InvalidImageError('Image data is malformed');
  }
  if (
    dimensions.widthPx > MAX_IMAGE_DIMENSION ||
    dimensions.heightPx > MAX_IMAGE_DIMENSION ||
    dimensions.widthPx * dimensions.heightPx > MAX_IMAGE_PIXELS
  ) {
    throw new InvalidImageError('Image dimensions are too large');
  }

  return {
    filename: normalizeImageFilename(filename, mimeType),
    mimeType,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('base64url'),
  };
}

export function detectImageMimeType(
  bytes: Uint8Array,
): SupportedImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function expectedImageChunkCount(byteLength: number): number {
  return Math.ceil(byteLength / IMAGE_CHUNK_BYTES);
}

function normalizeImageFilename(
  filename: string,
  mimeType: SupportedImageMimeType,
): string {
  const cleaned = Array.from(basename(filename).normalize('NFC'))
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint >= 32 &&
        !(codePoint >= 127 && codePoint <= 159) &&
        !(
          codePoint === 0x061c ||
          codePoint === 0x200e ||
          codePoint === 0x200f ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)
        )
      );
    })
    .join('')
    .trim()
    .slice(0, 160);

  return cleaned.length > 0 ? cleaned : `image.${extensionFor(mimeType)}`;
}

function extensionFor(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}
