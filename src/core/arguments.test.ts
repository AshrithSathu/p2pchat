import { describe, expect, it } from 'vitest';

import { parseArguments } from './arguments.js';

describe('parseArguments', () => {
  it('opens the app by default', () => {
    expect(parseArguments([])).toEqual({ kind: 'app' });
  });

  it('recognizes help flags', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' });
    expect(parseArguments(['-h'])).toEqual({ kind: 'help' });
  });

  it('recognizes version flags', () => {
    expect(parseArguments(['--version'])).toEqual({ kind: 'version' });
    expect(parseArguments(['-v'])).toEqual({ kind: 'version' });
  });
});
