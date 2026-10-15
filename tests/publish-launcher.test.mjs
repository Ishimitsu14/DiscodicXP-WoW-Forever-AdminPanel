import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('launcher publication keeps immutable binaries and switches the manifest after validation', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-launcher-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = resolve(root, 'downloads'), exe = resolve(root, 'launcher.exe');
  const script = fileURLToPath(new URL('../server/publish-launcher.sh', import.meta.url));
  const publish = (hash, version) => spawnSync('bash', [script, exe, hash, version], {
    env: { ...process.env, DISCODICXP_DOWNLOADS_PATH: output }, encoding: 'utf8'
  });
  const first = Buffer.from('MZ-first-launcher'), second = Buffer.from('MZ-second-launcher');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  await writeFile(exe, first);
  assert.equal(publish(hash(first), '0.3.0').status, 0);
  const manifest = async () => JSON.parse(await readFile(resolve(output, 'launcher/latest.json'), 'utf8'));
  assert.deepEqual(await manifest(), { version: '0.3.0', sha256: hash(first), size: first.length, downloadPath: `/downloads/launcher/${hash(first)}.exe` });
  await writeFile(exe, second);
  assert.notEqual(publish(hash(first), '0.3.1').status, 0);
  assert.notEqual(publish(hash(second), '../invalid').status, 0);
  assert.equal((await manifest()).version, '0.3.0');
  assert.equal(publish(hash(second), '0.3.1').status, 0);
  assert.deepEqual(await readFile(resolve(output, 'launcher', hash(first) + '.exe')), first);
  assert.deepEqual(await readFile(resolve(output, 'launcher', hash(second) + '.exe')), second);
  assert.deepEqual(await readFile(resolve(output, 'DiscodicXP.Launcher.exe')), second);
  assert.equal((await manifest()).sha256, hash(second));
});
