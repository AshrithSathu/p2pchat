import { StringDecoder } from 'node:string_decoder';

export class PassphraseCancelledError extends Error {
  public constructor() {
    super('Passphrase entry cancelled');
    this.name = 'PassphraseCancelledError';
  }
}

export function validateNewPassphrase(passphrase: string): string | null {
  if (passphrase.length < 12) {
    return 'Use at least 12 characters.';
  }

  if (passphrase.length > 1_024) {
    return 'Passphrase is too long.';
  }

  return null;
}

export async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('A TTY is required to enter the profile password.');
  }

  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  const decoder = new StringDecoder('utf8');
  const characters: string[] = [];

  output.write(label);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) {
        input.pause();
      }
    };

    const finish = (): void => {
      cleanup();
      output.write('\n');
      resolve(characters.join(''));
    };

    const cancel = (): void => {
      cleanup();
      output.write('\n');
      reject(new PassphraseCancelledError());
    };

    const onData = (chunk: Buffer): void => {
      const value = decoder.write(chunk);

      for (const character of value) {
        if (character === '\u0003') {
          cancel();
          return;
        }

        if (character === '\r' || character === '\n') {
          finish();
          return;
        }

        if (character === '\u007F' || character === '\b') {
          if (characters.pop() !== undefined) {
            output.write('\b \b');
          }
          continue;
        }

        const codePoint = character.codePointAt(0);
        if (
          codePoint !== undefined &&
          codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          characters.length < 1_024
        ) {
          characters.push(character);
          output.write('•');
        }
      }
    };

    input.on('data', onData);
  });
}
