import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = 'firstmate-gateway';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const INSTALL_MAX_BUFFER = 64 * 1024;

export interface RuntimeLayout {
  readonly root: string;
  readonly versions: string;
  readonly active: string;
}

export interface InstallRuntimeOptions {
  readonly artifact: string;
  readonly sha256: string;
  readonly root?: string;
  readonly npmPath?: string;
}

export interface InstalledRuntime {
  readonly packageName: string;
  readonly version: string;
  readonly sha256: string;
  readonly runtimeName: string;
  readonly runtimeDirectory: string;
  readonly activePointer: string;
  readonly previousRuntimeName?: string;
}

export interface RollbackRuntimeOptions {
  readonly runtimeName: string;
  readonly root?: string;
}

export interface RolledBackRuntime {
  readonly runtimeName: string;
  readonly runtimeDirectory: string;
  readonly activePointer: string;
  readonly previousRuntimeName?: string;
}

export class DeploymentError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeploymentError';
  }
}

export function defaultRuntimeRoot(): string {
  return resolve(process.env.FIRSTMATE_GATEWAY_RUNTIME_ROOT ?? join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'firstmate-gateway',
  ));
}

export function runtimeLayout(root = defaultRuntimeRoot()): RuntimeLayout {
  const normalizedRoot = resolve(root);
  return Object.freeze({
    root: normalizedRoot,
    versions: join(normalizedRoot, 'versions'),
    active: join(normalizedRoot, 'active'),
  });
}

export function validateRuntimeName(value: string): string {
  if (!RUNTIME_NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new DeploymentError('runtime name is invalid');
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function makeRuntimeImmutable(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeRuntimeImmutable(entryPath);
    } else if (!entry.isSymbolicLink()) {
      const mode = (await stat(entryPath)).mode;
      await chmod(entryPath, mode & 0o111 ? 0o555 : 0o444);
    }
  }
  await chmod(path, 0o555);
}

async function makeTreeRemovable(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isDirectory()) {
    for (const child of await readdir(path)) await makeTreeRemovable(join(path, child));
    await chmod(path, 0o700);
  } else if (!entry.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}

async function cleanupStaging(path: string): Promise<void> {
  try {
    await makeTreeRemovable(path);
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    throw new DeploymentError('unable to clean deployment staging', { cause: error });
  }
}

async function sha256File(path: string): Promise<string> {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function readPackageMetadata(packageRoot: string): Promise<{ readonly name: string; readonly version: string }> {
  try {
    const value = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (value.name !== PACKAGE_NAME || typeof value.version !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.version)) {
      throw new Error('invalid package metadata');
    }
    return { name: value.name, version: value.version };
  } catch (error) {
    throw new DeploymentError('packed artifact did not install a valid firstmate-gateway package', { cause: error });
  }
}

async function currentRuntimeName(layout: RuntimeLayout): Promise<string | undefined> {
  try {
    const entry = await lstat(layout.active);
    if (!entry.isSymbolicLink()) throw new DeploymentError('active runtime pointer is not a symbolic link');
    const target = await readlink(layout.active);
    const expectedPrefix = 'versions/';
    const name = target.startsWith(expectedPrefix) ? target.slice(expectedPrefix.length) : undefined;
    if (name === undefined || !RUNTIME_NAME_PATTERN.test(name)) {
      throw new DeploymentError('active runtime pointer is invalid');
    }
    return name;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new DeploymentError('unable to inspect active runtime pointer', { cause: error });
  }
}

async function atomicallyActivate(layout: RuntimeLayout, runtimeName: string): Promise<string | undefined> {
  validateRuntimeName(runtimeName);
  const runtimeDirectory = join(layout.versions, runtimeName);
  const runtimeEntry = await lstat(runtimeDirectory).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (runtimeEntry === undefined || !runtimeEntry.isDirectory()) {
    throw new DeploymentError('runtime directory does not exist');
  }

  const previousRuntimeName = await currentRuntimeName(layout);
  if (previousRuntimeName === runtimeName) return previousRuntimeName;

  const pointer = `${layout.active}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await symlink(join('versions', runtimeName), pointer);
  try {
    await rename(pointer, layout.active);
  } catch (error) {
    await rm(pointer, { force: true });
    throw new DeploymentError('unable to atomically update active runtime pointer', { cause: error });
  }
  return previousRuntimeName;
}

export async function installPackedArtifact(options: InstallRuntimeOptions): Promise<InstalledRuntime> {
  if (!isAbsolute(options.artifact)) throw new DeploymentError('artifact path must be absolute');
  const artifact = resolve(options.artifact);
  const expectedSha256 = options.sha256.toLowerCase();
  if (!SHA256_PATTERN.test(expectedSha256)) throw new DeploymentError('sha256 must be a 64-character lowercase hexadecimal digest');

  let artifactEntry;
  try {
    artifactEntry = await lstat(artifact);
  } catch (error) {
    throw new DeploymentError('packed artifact is not available', { cause: error });
  }
  if (!artifactEntry.isFile()) throw new DeploymentError('packed artifact must be a regular file');

  const layout = runtimeLayout(options.root);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.versions);
  const staging = await mkdtemp(join(layout.root, '.staging-'));
  await chmod(staging, 0o700);
  const stagedArtifact = join(staging, 'candidate.tgz');
  const runtimeStaging = join(staging, 'runtime');
  let createdRuntimeDirectory: string | undefined;
  try {
    // Copy first, then hash and install only this private snapshot. The original
    // path may be replaced after this point without changing the installed bytes.
    await copyFile(artifact, stagedArtifact);
    await chmod(stagedArtifact, 0o600);
    if (await sha256File(stagedArtifact) !== expectedSha256) {
      throw new DeploymentError('packed artifact sha256 does not match the expected digest');
    }
    await mkdir(runtimeStaging, { mode: 0o700 });

    const npmPath = options.npmPath ?? 'npm';
    try {
      await execFileAsync(npmPath, [
        'install',
        '--prefix', runtimeStaging,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        stagedArtifact,
      ], { cwd: layout.root, maxBuffer: INSTALL_MAX_BUFFER, windowsHide: true });
    } catch (error) {
      throw new DeploymentError('npm could not install the verified packed artifact', { cause: error });
    }

    const packageRoot = join(runtimeStaging, 'node_modules', PACKAGE_NAME);
    const metadata = await readPackageMetadata(packageRoot);
    const runtimeName = validateRuntimeName(`${metadata.version}-${expectedSha256.slice(0, 12)}`);
    const runtimeDirectory = join(layout.versions, runtimeName);
    const existing = await lstat(runtimeDirectory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isDirectory()) throw new DeploymentError('runtime directory is not a directory');
      const installed = await readPackageMetadata(join(runtimeDirectory, 'node_modules', PACKAGE_NAME));
      const marker = await readFile(join(runtimeDirectory, '.artifact-sha256'), 'utf8').catch(() => '');
      if (installed.name !== PACKAGE_NAME || installed.version !== metadata.version || marker.trim() !== expectedSha256) {
        throw new DeploymentError('an existing runtime directory does not match the verified artifact');
      }
    } else {
      await writeFile(join(runtimeStaging, '.artifact-sha256'), `${expectedSha256}\n`, { mode: 0o600 });
      // Rename while npm's directory tree is writable, then freeze the retained
      // version in its final location.
      await chmod(staging, 0o700);
      await chmod(layout.versions, 0o700);
      await rename(runtimeStaging, runtimeDirectory);
      createdRuntimeDirectory = runtimeDirectory;
      await makeRuntimeImmutable(runtimeDirectory);
    }

    const previousRuntimeName = await atomicallyActivate(layout, runtimeName);
    createdRuntimeDirectory = undefined;
    await cleanupStaging(staging);
    return Object.freeze({
      packageName: metadata.name,
      version: metadata.version,
      sha256: expectedSha256,
      runtimeName,
      runtimeDirectory,
      activePointer: layout.active,
      ...(previousRuntimeName === undefined ? {} : { previousRuntimeName }),
    });
  } catch (error) {
    let cleanupError: unknown;
    if (createdRuntimeDirectory !== undefined) {
      try {
        await makeTreeRemovable(createdRuntimeDirectory);
        await rm(createdRuntimeDirectory, { recursive: true, force: true });
      } catch (runtimeError) {
        cleanupError = runtimeError;
      }
    }
    try {
      await cleanupStaging(staging);
    } catch (stagingError) {
      cleanupError = stagingError;
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError('packed artifact installation failed', { cause: error });
  }
}

export async function rollbackRuntime(options: RollbackRuntimeOptions): Promise<RolledBackRuntime> {
  const runtimeName = validateRuntimeName(options.runtimeName);
  const layout = runtimeLayout(options.root);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.versions);
  const runtimeDirectory = join(layout.versions, runtimeName);
  await readPackageMetadata(join(runtimeDirectory, 'node_modules', PACKAGE_NAME));
  const marker = await readFile(join(runtimeDirectory, '.artifact-sha256'), 'utf8').catch(() => '');
  if (!SHA256_PATTERN.test(marker.trim())) throw new DeploymentError('runtime directory is not a verified artifact installation');
  const previousRuntimeName = await atomicallyActivate(layout, runtimeName);
  return Object.freeze({
    runtimeName,
    runtimeDirectory: join(layout.versions, runtimeName),
    activePointer: layout.active,
    ...(previousRuntimeName === undefined ? {} : { previousRuntimeName }),
  });
}

export const DEPLOYMENT_PACKAGE_NAME = PACKAGE_NAME;
