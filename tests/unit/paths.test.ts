import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { builtWebDir, findPackageRoot, readVersion } from '../../server/paths.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workhours-paths-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findPackageRoot', () => {
  test('finds this project from where the server code lives', () => {
    const root = findPackageRoot(join(import.meta.dirname, '..', '..', 'server'));
    expect(root).toBe(join(import.meta.dirname, '..', '..'));
    expect(findPackageRoot()).toBe(root);
  });

  test('skips package.json files that belong to something else', () => {
    const root = tempDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'work-hours', version: '9.9.9' }),
    );
    const nested = join(root, 'node_modules', 'other', 'lib');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'node_modules', 'other', 'package.json'), '{"name":"other"}');
    expect(findPackageRoot(nested)).toBe(root);
    expect(readVersion(root)).toBe('9.9.9');
  });

  test('throws when there is none', () => {
    expect(() => findPackageRoot(tempDir())).toThrow(/Could not find/);
  });
});

describe('builtWebDir', () => {
  test('is null until the UI is built, then the dist/web folder', () => {
    const root = tempDir();
    expect(builtWebDir(root)).toBeNull();
    mkdirSync(join(root, 'dist', 'web'), { recursive: true });
    expect(builtWebDir(root)).toBeNull();
    writeFileSync(join(root, 'dist', 'web', 'index.html'), '<!doctype html>');
    expect(builtWebDir(root)).toBe(join(root, 'dist', 'web'));
  });
});
