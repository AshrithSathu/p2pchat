import { describe, expect, it } from 'vitest';

import { extractDroppedFilePath } from './image-input.js';

describe('extractDroppedFilePath', () => {
  it('accepts terminal quoting and escaped spaces', () => {
    expect(extractDroppedFilePath("'/tmp/My photo.png' ")).toBe(
      '/tmp/My photo.png',
    );
    expect(extractDroppedFilePath('/tmp/My\\ photo.png ')).toBe(
      '/tmp/My photo.png',
    );
    expect(extractDroppedFilePath('"C:\\Users\\me\\photo.png"')).toBe(
      'C:\\Users\\me\\photo.png',
    );
  });

  it('accepts file URLs and rejects multiline text', () => {
    expect(extractDroppedFilePath('file:///tmp/My%20photo.png')).toBe(
      '/tmp/My photo.png',
    );
    expect(extractDroppedFilePath('hello\nworld')).toBeNull();
  });
});
