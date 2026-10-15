import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Database, passwordMatches } from '../server/database.mjs';

const setup = fileURLToPath(new URL('../server/setup.mjs', import.meta.url));
async function execute(path, args, input = '') {
  const process = spawn(globalThis.process.execPath, [setup, ...args], {
    env: { ...globalThis.process.env, DATABASE_PATH: path }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { output += chunk; });
  const completed = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => resolve({ code, output }));
  });
  process.stdin.end(input);
  return completed;
}

test('admin creation reads credentials from stdin, stores a hash and never prints the password', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, 'database.sqlite'), password = 'setup-test-password-1234';
  const result = await execute(path, ['--stdin'], `admin\0${password}`);
  assert.equal(result.code, 0); assert.equal(result.output.includes(password), false);
  const db = new Database(path);
  try {
    const admin = db.get('SELECT * FROM admins WHERE login=?', 'admin');
    assert.notEqual(admin.password, password); assert.equal(passwordMatches(password, admin.password), true);
  } finally { db.close(); }
  const duplicate = await execute(path, ['--stdin'], `admin\0${password}`);
  assert.notEqual(duplicate.code, 0); assert.equal(duplicate.output.includes(password), false);
});

test('invalid or malformed credential input fails without exposing its content', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, 'database.sqlite');
  assert.notEqual((await execute(path, ['--stdin'], 'admin\0short')).code, 0);
  assert.notEqual((await execute(path, ['--stdin'], 'malformed')).code, 0);
  const file = resolve(root, 'invalid.json'), marker = 'private-test-marker';
  await writeFile(file, `{"password":"${marker}"`);
  const result = await execute(path, [file]);
  assert.notEqual(result.code, 0); assert.equal(result.output.includes(marker), false);
});
