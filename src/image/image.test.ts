import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  expectedImageChunkCount,
  IMAGE_CHUNK_BYTES,
  InvalidImageError,
  loadImageFile,
  MAX_IMAGE_BYTES,
  prepareImage,
} from './image.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('image preparation', () => {
  it('detects content from magic bytes and normalizes unsafe filenames', () => {
    const image = prepareImage(png, '\u001B[2Jphoto\u202Egnp.png');

    expect(image.mimeType).toBe('image/png');
    expect(image.filename).toBe('[2Jphotognp.png');
    expect(image.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects unsupported and oversized payloads', () => {
    expect(() => prepareImage(Buffer.from('not an image'), 'note.txt')).toThrow(
      InvalidImageError,
    );
    expect(() =>
      prepareImage(Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89), 'huge.png'),
    ).toThrow('2 MiB');
  });

  it('uses chunks that fit inside Signal plaintext frames', () => {
    expect(expectedImageChunkCount(IMAGE_CHUNK_BYTES * 2 + 1)).toBe(3);
  });

  it('loads and validates a bounded image through one file handle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p2pchat-image-'));
    try {
      const path = join(directory, 'photo.png');
      await writeFile(path, png);

      await expect(loadImageFile(path)).resolves.toMatchObject({
        filename: 'photo.png',
        mimeType: 'image/png',
        bytes: png,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects oversized image files before processing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p2pchat-image-'));
    try {
      const path = join(directory, 'huge.png');
      await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89));

      await expect(loadImageFile(path)).rejects.toThrow('2 MiB');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
