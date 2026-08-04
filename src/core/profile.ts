export const DEFAULT_PROFILE_NAME = 'default';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

export function normalizeProfileName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(normalized)) {
    throw new Error(
      'Profile name must be 1-32 characters using letters, numbers, _ or -.',
    );
  }
  return normalized;
}
