import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, defaultConfigPath } from './config.js';

export interface InitializeConfigOptions {
  readonly force?: boolean;
}

export interface InitializeConfigResult {
  readonly path: string;
  readonly created: true;
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isFileAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Creates a local configuration from the safe package example. Existing files
 * are never replaced unless the caller explicitly opts into force mode.
 */
export async function initializeConfig(
  filePath = defaultConfigPath(),
  options: InitializeConfigOptions = {},
): Promise<InitializeConfigResult> {
  const path = resolve(filePath);
  if (!options.force) {
    try {
      await access(path, constants.F_OK);
      throw new ConfigError('configuration file already exists; use --force to replace it');
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
  }

  let template: string;
  try {
    template = await readFile(fileURLToPath(new URL('../config/example.yaml', import.meta.url)), 'utf8');
  } catch (error) {
    throw new ConfigError('configuration example is unavailable', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, template, {
      encoding: 'utf8',
      mode: 0o600,
      flag: options.force ? 'w' : 'wx',
    });
  } catch (error) {
    if (isFileAlreadyExists(error) && !options.force) {
      throw new ConfigError('configuration file already exists; use --force to replace it');
    }
    throw new ConfigError('unable to create configuration file', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return Object.freeze({ path, created: true });
}
