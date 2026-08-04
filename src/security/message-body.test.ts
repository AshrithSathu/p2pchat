import { describe, expect, it } from 'vitest';

import {
  InvalidMessageBodyError,
  prepareMessageBody,
  sanitizeTerminalText,
} from './message-body.js';

describe('prepareMessageBody', () => {
  it('removes terminal control bytes and bidirectional overrides', () => {
    expect(
      prepareMessageBody(
        '\u001B]52;c;stolen\u0007\u001B[2Jhello\u202Egpj.exe\u202C',
      ),
    ).toBe(']52;c;stolen[2Jhellogpj.exe');
  });

  it('preserves ordinary Unicode and normalizes line endings', () => {
    expect(prepareMessageBody('hi\r\nthere 👋\t!')).toBe('hi\nthere 👋    !');
  });

  it('rejects empty and oversized messages', () => {
    expect(() => prepareMessageBody('\u001B\t')).toThrow(
      InvalidMessageBodyError,
    );
    expect(() => prepareMessageBody('x'.repeat(4_001))).toThrow(
      InvalidMessageBodyError,
    );
  });

  it('bounds untrusted status text without rejecting it', () => {
    expect(sanitizeTerminalText('\u001B[2Jabcdef', 4)).toBe('[2Ja');
  });
});
