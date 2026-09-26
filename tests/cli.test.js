/**
 * CLI tests: version, scaffolding (plain name, absolute path, --force),
 * refusal on non-empty directories and the `routes` inspector.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'cli.js');
const LIB_ENTRY = path.join(__dirname, '..', 'lib', 'webcraft.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: cwd || os.tmpdir(), encoding: 'utf8' });
}

test('--version prints the framework version', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^webcraft v\d+\.\d+\.\d+/);
});

test('help lists the available commands', () => {
  const result = runCli(['help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /webcraft new <name>/);
  assert.match(result.stdout, /webcraft routes <file>/);
});

test('new <name> scaffolds a complete application', () => {
  const target = path.join(os.tmpdir(), `webcraft-scaffold-${Date.now()}-${process.pid}`);
  try {
    const result = runCli(['new', target]);
    assert.equal(result.status, 0, result.stderr);
    for (const file of [
      'package.json',
      'app.js',
      'routes/index.js',
      'views/layout.html',
      'views/home.html',
      'public/css/style.css',
      'public/js/main.js',
      'README.md',
      '.gitignore',
    ]) {
      assert.ok(fs.existsSync(path.join(target, file)), `missing ${file}`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, path.basename(target)); // app name derived from the target basename
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.dependencies.webcraft);
    const appSource = fs.readFileSync(path.join(target, 'app.js'), 'utf8');
    assert.match(appSource, /from 'webcraft'/);
    // The generated modules must be valid JavaScript (the scaffold's
    // package.json declares "type": "module", so node --check parses ESM).
    for (const mod of ['app.js', path.join('routes', 'index.js')]) {
      const check = spawnSync(process.execPath, ['--check', path.join(target, mod)], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr || `syntax error in ${mod}`);
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('new refuses non-empty directories without --force, succeeds with it', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-nonempty-'));
  try {
    fs.writeFileSync(path.join(target, 'existing.txt'), 'keep me');
    const refused = runCli(['new', target]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not empty/);
    assert.equal(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8'), 'keep me');

    const forced = runCli(['new', target, '--force']);
    assert.equal(forced.status, 0);
    assert.ok(fs.existsSync(path.join(target, 'app.js')));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('invalid application names are rejected', () => {
  const result = runCli(['new', 'bad name!']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid application name/);
  const missing = runCli(['new']);
  assert.equal(missing.status, 2);
});

test('routes <file> prints the route table of an app module', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webcraft-routes-'));
  const appFile = path.join(tmp, 'sample-app.mjs');
  fs.writeFileSync(appFile, `
import { createApp } from ${JSON.stringify(LIB_ENTRY)};
const app = createApp();
app.get('/users/:id', () => {}, { name: 'users.show' });
app.post('/users', () => {}, { name: 'users.create' });
export default app;
`);
  try {
    const result = spawnSync(process.execPath, [CLI, 'routes', appFile], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GET\s+\/users\/:id\s+# users\.show/);
    assert.match(result.stdout, /POST\s+\/users\s+# users\.create/);
    assert.match(result.stdout, /2 route\(s\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
