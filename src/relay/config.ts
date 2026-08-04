const DEFAULT_RELAY_ENDPOINT = 'https://p2pchat-relay.sathuashrith.com';

export function resolveRelayEndpoint(): string | null {
  const configured = process.env['P2PCHAT_RELAY_URL']?.trim();
  const value =
    configured === undefined || configured === ''
      ? DEFAULT_RELAY_ENDPOINT
      : configured;
  return value === '' ? null : value;
}
