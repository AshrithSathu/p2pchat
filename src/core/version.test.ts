import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { APP_VERSION } from './version.js';

const packageMetadataSchema = z.object({ version: z.string() });

describe('APP_VERSION', () => {
  it('matches the package version', async () => {
    const packageJson = await readFile(
      join(process.cwd(), 'package.json'),
      'utf8',
    );
    const metadata = packageMetadataSchema.parse(JSON.parse(packageJson));

    expect(APP_VERSION).toBe(metadata.version);
  });
});
