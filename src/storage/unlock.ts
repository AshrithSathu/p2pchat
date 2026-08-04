import { LocalStore } from './local-store.js';
import { promptHidden, validateNewPassphrase } from './passphrase.js';

async function createPassphrase(profileName: string): Promise<string> {
  for (;;) {
    const passphrase = await promptHidden(
      `Create password for profile "${profileName}": `,
    );
    const validationError = validateNewPassphrase(passphrase);
    if (validationError !== null) {
      process.stderr.write(`${validationError}\n`);
      continue;
    }

    const confirmation = await promptHidden(
      `Confirm password for profile "${profileName}": `,
    );
    if (confirmation !== passphrase) {
      process.stderr.write('Passphrases do not match. Try again.\n');
      continue;
    }

    return passphrase;
  }
}

export async function obtainPassphrase(
  directory: string,
  profileName = 'default',
): Promise<string> {
  if (await LocalStore.exists(directory)) {
    return await promptHidden(`Unlock profile "${profileName}": `);
  }

  process.stdout.write(
    `Creating local profile "${profileName}".\n` +
      "Its password encrypts only this profile's identity and message history.\n" +
      'It cannot be recovered if you lose it.\n\n',
  );
  return await createPassphrase(profileName);
}
