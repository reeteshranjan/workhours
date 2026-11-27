import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE_NAME = 'work-hours';

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Walks up from `from` to the folder whose package.json is Work Hours' own. Works from `server/`
 * under tsx and from `dist/server/` after the build.
 */
export function findPackageRoot(from: string = import.meta.dirname): string {
  let dir = from;
  for (;;) {
    if (readPackageJson(dir)?.['name'] === PACKAGE_NAME) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find the Work Hours package folder above ${from}.`);
    }
    dir = parent;
  }
}

/** The `version` in the package's package.json. */
export function readVersion(root: string): string {
  const version = readPackageJson(root)?.['version'];
  if (typeof version !== 'string') {
    throw new Error(`No version found in ${join(root, 'package.json')}.`);
  }
  return version;
}

/**
 * The built UI (`<root>/dist/web`), or null if it hasn't been built. Under `npm run dev` the UI
 * comes from Vite instead, so null is expected there.
 */
export function builtWebDir(root: string): string | null {
  const dir = join(root, 'dist', 'web');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}
