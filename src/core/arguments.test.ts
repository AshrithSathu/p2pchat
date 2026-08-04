import { describe, expect, it } from 'vitest';

import { parseArguments } from './arguments.js';

describe('parseArguments', () => {
  it('opens the app by default', () => {
    expect(parseArguments([])).toEqual({
      kind: 'app',
      profileName: 'default',
    });
  });

  it('recognizes help flags', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' });
    expect(parseArguments(['-h'])).toEqual({ kind: 'help' });
  });

  it('recognizes version flags', () => {
    expect(parseArguments(['--version'])).toEqual({ kind: 'version' });
    expect(parseArguments(['-v'])).toEqual({ kind: 'version' });
  });

  it('normalizes named local profiles', () => {
    expect(parseArguments(['--profile', 'Alice'])).toEqual({
      kind: 'app',
      profileName: 'alice',
    });
    expect(parseArguments(['--user=bob-dev'])).toEqual({
      kind: 'app',
      profileName: 'bob-dev',
    });
    expect(parseArguments(['-p', 'tester_2'])).toEqual({
      kind: 'app',
      profileName: 'tester_2',
    });
  });

  it('rejects missing, invalid, duplicate, and unknown arguments', () => {
    expect(() => parseArguments(['--profile'])).toThrow('Missing profile');
    expect(() => parseArguments(['--profile', '../alice'])).toThrow(
      'Profile name',
    );
    expect(() =>
      parseArguments(['--profile', 'alice', '--user', 'bob']),
    ).toThrow('only be specified once');
    expect(() => parseArguments(['--unknown'])).toThrow('Unknown argument');
  });
});
