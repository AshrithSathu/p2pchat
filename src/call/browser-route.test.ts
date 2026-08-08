import { describe, expect, it } from 'vitest';

import { assertSelectedRelayRoute } from './browser-route.js';

describe('selected WebRTC relay route', () => {
  it.each(['relay', 'prflx'] as const)(
    'accepts a relay local candidate with a %s remote candidate',
    (remoteCandidateType) => {
      expect(() =>
        assertSelectedRelayRoute(
          { type: 'local-candidate', candidateType: 'relay' },
          {
            type: 'remote-candidate',
            candidateType: remoteCandidateType,
          },
        ),
      ).not.toThrow();
    },
  );

  it.each(['host', 'srflx', 'prflx'] as const)(
    'rejects a %s local candidate',
    (localCandidateType) => {
      expect(() =>
        assertSelectedRelayRoute(
          {
            type: 'local-candidate',
            candidateType: localCandidateType,
          },
          { type: 'remote-candidate', candidateType: 'relay' },
        ),
      ).toThrow('non-relay local route');
    },
  );

  it.each(['host', 'srflx'] as const)(
    'rejects a %s remote candidate',
    (remoteCandidateType) => {
      expect(() =>
        assertSelectedRelayRoute(
          { type: 'local-candidate', candidateType: 'relay' },
          {
            type: 'remote-candidate',
            candidateType: remoteCandidateType,
          },
        ),
      ).toThrow('unexpected remote ICE route');
    },
  );

  it('rejects missing candidate statistics', () => {
    expect(() => assertSelectedRelayRoute(undefined, undefined)).toThrow(
      'non-relay local route',
    );
  });
});
