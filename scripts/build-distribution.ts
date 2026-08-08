import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

interface ArtifactMetadata {
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}

const targets = {
  'darwin-arm64': {
    signalDirectory: 'darwin-arm64',
    sqliteFilename: 'darwin-arm64.node',
  },
  'darwin-x64': {
    signalDirectory: 'darwin-x64',
    sqliteFilename: 'darwin-x64.node',
  },
  'linux-arm64': {
    signalDirectory: 'linux-arm64',
    sqliteFilename: 'linux-arm64.node',
  },
  'linux-x64': {
    signalDirectory: 'linux-x64',
    sqliteFilename: 'linux-x64.node',
  },
} as const;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = join(projectRoot, 'release');

async function main(): Promise<void> {
  const packageManifest = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(packageManifest.version)
  ) {
    throw new Error(`Invalid release version: ${packageManifest.version}`);
  }

  await rm(releaseDirectory, { recursive: true, force: true });
  await mkdir(releaseDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'p2pchat-distribution-'),
  );

  try {
    const artifacts = {} as Record<keyof typeof targets, ArtifactMetadata>;
    for (const [target, nativeFiles] of Object.entries(targets) as [
      keyof typeof targets,
      (typeof targets)[keyof typeof targets],
    ][]) {
      const deploymentDirectory = join(temporaryDirectory, target, 'p2pchat');
      await run('pnpm', [
        '--store-dir',
        join(temporaryDirectory, '.pnpm-store'),
        '--config.ignore-scripts=true',
        '--filter',
        packageManifest.name,
        'deploy',
        '--prod',
        deploymentDirectory,
      ]);
      await pruneNativePrebuilds(deploymentDirectory, nativeFiles);

      const filename = `p2pchat-v${packageManifest.version}-${target}.tar.gz`;
      const archivePath = join(releaseDirectory, filename);
      await run(
        'tar',
        [
          '--no-xattrs',
          '-czf',
          archivePath,
          '-C',
          dirname(deploymentDirectory),
          'p2pchat',
        ],
        { COPYFILE_DISABLE: '1' },
      );
      artifacts[target] = await describeArtifact(archivePath);
    }

    const sourceFilename = `p2pchat-v${packageManifest.version}-source.tar.gz`;
    const sourceArchive = join(releaseDirectory, sourceFilename);
    await buildSourceArchive(temporaryDirectory, sourceArchive);
    const source = await describeArtifact(sourceArchive);
    const manifest = {
      version: packageManifest.version,
      releasedAt: new Date().toISOString(),
      artifacts,
      source,
    };
    await writeFile(
      join(releaseDirectory, 'latest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 },
    );

    const checksumLines = [...Object.values(artifacts), source]
      .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
      .join('\n');
    await writeFile(
      join(releaseDirectory, 'SHA256SUMS.txt'),
      `${checksumLines}\n`,
      { mode: 0o644 },
    );
    process.stdout.write(
      `Built p2pchat ${packageManifest.version} distribution artifacts in ${relative(
        projectRoot,
        releaseDirectory,
      )}/\n`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function pruneNativePrebuilds(
  deploymentDirectory: string,
  nativeFiles: {
    readonly signalDirectory: string;
    readonly sqliteFilename: string;
  },
): Promise<void> {
  await rm(join(deploymentDirectory, '.pnpm-store'), {
    recursive: true,
    force: true,
  });

  const signalPrebuilds = join(
    deploymentDirectory,
    'node_modules',
    '@signalapp',
    'libsignal-client',
    'prebuilds',
  );
  for (const entry of await readdir(signalPrebuilds)) {
    if (entry !== nativeFiles.signalDirectory) {
      await rm(join(signalPrebuilds, entry), { recursive: true, force: true });
    }
  }

  const sqlitePrebuilds = join(
    deploymentDirectory,
    'node_modules',
    'better-sqlite3',
    'prebuilds',
  );
  for (const entry of await readdir(sqlitePrebuilds)) {
    if (entry !== nativeFiles.sqliteFilename) {
      await rm(join(sqlitePrebuilds, entry), { force: true });
    }
  }
  await rm(
    join(deploymentDirectory, 'node_modules', 'better-sqlite3', 'build'),
    { recursive: true, force: true },
  );
}

async function buildSourceArchive(
  temporaryDirectory: string,
  outputPath: string,
): Promise<void> {
  const sourceRoot = join(temporaryDirectory, 'source', 'p2pchat-source');
  const fileList = (
    await capture('git', [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
    ])
  )
    .split('\n')
    .filter((path) => path.length > 0);

  for (const path of fileList) {
    const source = join(projectRoot, path);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) {
      continue;
    }
    const destination = join(sourceRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await run(
    'tar',
    [
      '--no-xattrs',
      '-czf',
      outputPath,
      '-C',
      dirname(sourceRoot),
      'p2pchat-source',
    ],
    { COPYFILE_DISABLE: '1' },
  );
}

async function describeArtifact(path: string): Promise<ArtifactMetadata> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  return {
    filename: path.slice(path.lastIndexOf('/') + 1),
    sha256: hash.digest('hex'),
    bytes: (await stat(path)).size,
  };
}

async function capture(
  command: string,
  arguments_: readonly string[],
): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString('utf8'));
      } else {
        rejectPromise(
          new Error(`${command} exited with status ${String(code)}`),
        );
      }
    });
  });
}

async function run(
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`${command} exited with status ${String(code)}`),
        );
      }
    });
  });
}

await main();
