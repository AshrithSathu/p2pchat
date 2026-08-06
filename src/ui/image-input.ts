import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { prepareImage, type PreparedImage } from '../image/image.js';

export type ClipboardContent =
  | Readonly<{ kind: 'image'; image: PreparedImage }>
  | Readonly<{ kind: 'text'; text: string }>;

interface ClipboardModule {
  getImageBinary(): Promise<number[]>;
  getText(): Promise<string>;
  hasImage(): boolean;
}

const moduleRequire = createRequire(import.meta.url);
let loadedClipboard: ClipboardModule | null | undefined;

export async function readClipboardContent(): Promise<ClipboardContent | null> {
  const clipboard = loadClipboard();
  if (clipboard === null) {
    return null;
  }
  if (clipboard.hasImage()) {
    const bytes = await clipboard.getImageBinary();
    if (bytes.length > 0) {
      return {
        kind: 'image',
        image: prepareImage(
          Uint8Array.from(bytes),
          `clipboard-${new Date().toISOString().replaceAll(':', '-')}.png`,
        ),
      };
    }
  }

  const text = await clipboard.getText();
  return text.length > 0 ? { kind: 'text', text } : null;
}

function loadClipboard(): ClipboardModule | null {
  if (loadedClipboard !== undefined) {
    return loadedClipboard;
  }
  try {
    loadedClipboard = moduleRequire(
      '@mariozechner/clipboard',
    ) as ClipboardModule;
  } catch {
    loadedClipboard = null;
  }
  return loadedClipboard;
}

/**
 * Converts the single path emitted when a file is dropped onto a terminal.
 * Quoting and escaped spaces used by macOS/Linux terminals are accepted.
 */
export function extractDroppedFilePath(input: string): string | null {
  const value = input.trim();
  if (value.length === 0 || value.includes('\n') || value.includes('\0')) {
    return null;
  }

  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }

  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.length < 2 || value.at(-1) !== quote) {
      return null;
    }
    const inner = value.slice(1, -1);
    return quote === "'"
      ? inner.replaceAll("'\\''", "'")
      : decodeTerminalEscapes(inner);
  }

  if (/\s/u.test(value.replaceAll('\\ ', ''))) {
    return null;
  }
  return decodeTerminalEscapes(value);
}

function decodeTerminalEscapes(value: string): string {
  return value.replace(/\\([\\\s"'])/gu, '$1');
}
