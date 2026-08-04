import { describe, expect, it } from 'vitest';

import {
  createUiAutocompleteProvider,
  parseUiCommand,
  UI_COMMAND_SUGGESTIONS,
} from './commands.js';

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

  it('offers and applies fuzzy slash-command completions', async () => {
    const provider = createUiAutocompleteProvider(process.cwd());
    const signal = new AbortController().signal;
    const allSuggestions = await provider.getSuggestions(['/'], 0, 1, {
      signal,
    });

    expect(allSuggestions?.items.map((item) => item.value)).toEqual(
      UI_COMMAND_SUGGESTIONS.map((command) => command.name),
    );

    const filteredSuggestions = await provider.getSuggestions(['/jo'], 0, 3, {
      signal,
    });
    expect(filteredSuggestions).toEqual({
      items: [
        {
          value: 'join',
          label: 'join',
          description: '<code> — Join using an invite code',
        },
      ],
      prefix: '/jo',
    });

    const joinSuggestion = filteredSuggestions?.items[0];
    expect(joinSuggestion).toBeDefined();
    if (joinSuggestion === undefined) {
      throw new Error('Expected the join command suggestion');
    }
    expect(
      provider.applyCompletion(['/jo'], 0, 3, joinSuggestion, '/jo'),
    ).toEqual({
      lines: ['/join '],
      cursorLine: 0,
      cursorCol: 6,
    });
  });
});
