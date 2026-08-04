import { LocalStore } from './local-store.js';
import { promptHidden, validateNewPassphrase } from './passphrase.js';

async function createPassphrase(): Promise<string> {
  for (;;) {
    const passphrase = await promptHidden('Create local passphrase: ');
    const validationError = validateNewPassphrase(passphrase);
    if (validationError !== null) {
      process.stderr.write(`${validationError}\n`);
      continue;
    }

    const confirmation = await promptHidden('Confirm passphrase: ');
    if (confirmation !== passphrase) {
      process.stderr.write('Passphrases do not match. Try again.\n');
      continue;
    }

    return passphrase;
  }
}

export async function obtainPassphrase(directory: string): Promise<string> {
  const environmentPassphrase = process.env['P2PCHAT_PASSPHRASE'];
  if (environmentPassphrase !== undefined && environmentPassphrase.length > 0) {
    return environmentPassphrase;
  }

  if (await LocalStore.exists(directory)) {
    return await promptHidden('Unlock local chats: ');
  }

  process.stdout.write(
    'Your passphrase encrypts the local identity and message history.\n' +
      'It cannot be recovered if you lose it.\n\n',
  );
  return await createPassphrase();
}
