type CandidateStatsType = 'local-candidate' | 'remote-candidate';

interface IceCandidateStats {
  readonly type: CandidateStatsType;
  readonly candidateType: string;
}

export function assertSelectedRelayRoute(
  local: unknown,
  remote: unknown,
): void {
  if (!isCandidateStats(local, 'local-candidate', ['relay'])) {
    throw new Error('Call attempted to use a non-relay local route');
  }
  if (!isCandidateStats(remote, 'remote-candidate', ['relay', 'prflx'])) {
    throw new Error('Call received an unexpected remote ICE route');
  }
}

function isCandidateStats(
  value: unknown,
  type: CandidateStatsType,
  allowedCandidateTypes: readonly string[],
): value is IceCandidateStats {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === type &&
    'candidateType' in value &&
    typeof value.candidateType === 'string' &&
    allowedCandidateTypes.includes(value.candidateType)
  );
}
