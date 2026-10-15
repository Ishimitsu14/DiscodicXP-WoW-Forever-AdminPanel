import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('CI deployment switches code and restores it on failure without changing persistent data', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0
}, async t => {
  const script = fileURLToPath(new URL('../server/ci-deploy.sh', import.meta.url));
  for (const failure of ['', 'npm', 'health']) {
    await t.test(failure || 'success', async t => {
      const root = await mkdtemp(resolve(tmpdir(), 'dxp-ci-deploy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const installed = resolve(root, 'installed'), source = resolve(root, 'source'), runtime = resolve(root, 'bin');
      for (const path of [installed, source]) {
        await mkdir(resolve(path, 'server'), { recursive: true });
        await mkdir(resolve(path, 'public'));
      }
      await mkdir(runtime);
      await writeFile(resolve(installed, 'server/old.mjs'), 'previous code');
      await writeFile(resolve(installed, '.deploy-revision'), 'previous revision');
      await writeFile(resolve(installed, 'public/obsolete.html'), 'old page');
      await writeFile(resolve(source, 'server/index.mjs'), 'new code');
      await writeFile(resolve(source, 'public/index.html'), 'new page');
      for (const name of ['package.json', 'package-lock.json']) await writeFile(resolve(source, name), '{}');
      const database = resolve(root, 'persistent.sqlite'), settings = resolve(root, 'service.env'), downloads = resolve(root, 'launcher.exe');
      await writeFile(database, 'saved player progress');
      await writeFile(settings, 'private settings');
      await writeFile(downloads, 'previous launcher');
      const commands = {
        node: 'exit 0',
        npm: '[[ "$MOCK_FAILURE" != npm ]] || exit 1\nmkdir -p "$3/node_modules"',
        systemctl: 'printf "%s\\n" "$*" >> "$MOCK_LOG"',
        curl: 'if [[ "$MOCK_FAILURE" == health && "${!#}" == https:* ]]; then exit 1; fi'
      };
      for (const [name, body] of Object.entries(commands)) {
        await writeFile(resolve(runtime, name), '#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n', { mode: 0o755 });
      }
      const revision = 'a'.repeat(40), log = resolve(root, 'commands.log');
      const result = spawnSync('bash', [script, source, revision, 'https://updates.example.com'], {
        env: { ...process.env, PATH: runtime + ':' + process.env.PATH, DISCODICXP_INSTALL_PATH: installed,
          DISCODICXP_RUNTIME_PATH: runtime, DISCODICXP_LOCK_PATH: resolve(root, 'deploy.lock'), MOCK_FAILURE: failure, MOCK_LOG: log },
        encoding: 'utf8'
      });
      if (!failure) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(resolve(installed, '.deploy-revision'), 'utf8'), revision + '\n');
        assert.equal(await readFile(resolve(installed, 'server/index.mjs'), 'utf8'), 'new code');
        await assert.rejects(readFile(resolve(installed, 'public/obsolete.html')), { code: 'ENOENT' });
        assert.match(await readFile(log, 'utf8'), /stop discodicxp-update\nstart discodicxp-update/);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(resolve(installed, 'server/old.mjs'), 'utf8'), 'previous code');
        assert.equal(await readFile(resolve(installed, '.deploy-revision'), 'utf8'), 'previous revision');
        if (failure === 'npm') await assert.rejects(readFile(log), { code: 'ENOENT' });
        else assert.match(await readFile(log, 'utf8'), /restart discodicxp-update/);
      }
      assert.equal(await readFile(database, 'utf8'), 'saved player progress');
      assert.equal(await readFile(settings, 'utf8'), 'private settings');
      assert.equal(await readFile(downloads, 'utf8'), 'previous launcher');
    });
  }
});
