import { describe, expect, it } from 'vitest';

import { parseUiCommand } from './commands.js';

describe('parseUiCommand', () => {
  it('ignores empty submissions', () => {
    expect(parseUiCommand('   ')).toBeNull();
  });

  it('parses commands without losing join codes', () => {
    expect(parseUiCommand('/new')).toEqual({ kind: 'new-chat' });
    expect(parseUiCommand('/new-local')).toEqual({
      kind: 'new-local-chat',
    });
    expect(parseUiCommand('/join  swift-copper-73  ')).toEqual({
      kind: 'join',
      code: 'swift-copper-73',
    });
    expect(parseUiCommand('/source')).toEqual({ kind: 'source' });
    expect(parseUiCommand('/license')).toEqual({ kind: 'license' });
  });

  it('treats regular text as a future chat message', () => {
    expect(parseUiCommand('  hello peer  ')).toEqual({
      kind: 'message',
      body: 'hello peer',
    });
  });
});
