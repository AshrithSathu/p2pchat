const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_MESSAGE_BYTES = 16 * 1024;

const DIRECTIONAL_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export class InvalidMessageBodyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageBodyError';
  }
}

function removeTerminalControls(input: string): string {
  const normalized = input
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '    ')
    .replace(DIRECTIONAL_CONTROLS, '')
    .normalize('NFC');
  return Array.from(normalized)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint === 10 ||
        (codePoint !== undefined &&
          codePoint >= 32 &&
          !(codePoint >= 127 && codePoint <= 159))
      );
    })
    .join('');
}

function graphemes(input: string): readonly string[] {
  return Array.from(
    GRAPHEME_SEGMENTER.segment(input),
    ({ segment }) => segment,
  );
}

export function sanitizeTerminalText(
  input: string,
  maxCharacters = 4_000,
): string {
  return graphemes(removeTerminalControls(input))
    .slice(0, maxCharacters)
    .join('');
}

/**
 * Produces text that can be rendered by a terminal without interpreting any
 * peer-controlled bytes as escape sequences or bidirectional overrides.
 */
export function prepareMessageBody(input: string): string {
  const normalized = removeTerminalControls(input);

  if (normalized.trim().length === 0) {
    throw new InvalidMessageBodyError('Message cannot be empty');
  }

  if (graphemes(normalized).length > MAX_MESSAGE_CHARACTERS) {
    throw new InvalidMessageBodyError(
      `Message exceeds ${String(MAX_MESSAGE_CHARACTERS)} characters`,
    );
  }

  if (Buffer.byteLength(normalized, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new InvalidMessageBodyError('Message is too large');
  }

  return normalized;
}
