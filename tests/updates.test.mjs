import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createUpdateServer, tokenDigest } from '../server/updates.mjs';
import { ReleaseStore, selectPackage } from '../server/releases.mjs';

const packageBytes = Buffer.from('a verified addon archive');
const sha256 = createHash('sha256').update(packageBytes).digest('hex');
const token = `dxp_${'a'.repeat(43)}`;
const release = (version = '0.3.1', body = packageBytes) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ id: 42, name: `DiscodicXP-${version}-personal.zip`, size: body.length,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}` }] });

async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const state = { release: release(), body: packageBytes };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (state.fail) throw new Error('private upstream details');
    if (url.endsWith('/releases/latest')) return Response.json(state.release);
    return new Response(state.body);
  };
  const store = new ReleaseStore({ repository: 'owner/private-addon', githubToken: 'github_secret', cachePath: root,
    fetchImpl, refreshMs: 0, ...options });
  return { root, calls, state, store };
}

test('only the matching full release with a trustworthy checksum can be installed', () => {
  assert.equal(selectPackage(release(), 1024).version, '0.3.1');
  for (const invalid of [
    { ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), tag_name: 'launcher-v1.0.0' },
    { ...release(), assets: [] },
    { ...release(), assets: [release().assets[0], release().assets[0]] },
    { ...release(), assets: [{ ...release().assets[0], digest: null }] },
    { ...release(), assets: [{ ...release().assets[0], name: 'source.zip' }] },
  ]) assert.throws(() => selectPackage(invalid, 1024));
  assert.throws(() => selectPackage(release(), 2));
});

test('parallel checks download once and store an immutable verified package', async t => {
  const { root, store, calls } = await fixture(t);
  const results = await Promise.all([store.latest(), store.latest(), store.latest()]);
  assert.equal(calls.length, 2);
  assert.deepEqual(results[0], results[2]);
  assert.equal(results[0].downloadPath, `/v1/packages/${sha256}.zip`);
  assert.deepEqual(await readFile(resolve(root, `${sha256}.zip`)), packageBytes);
  assert.equal(JSON.stringify(results).includes('github_secret'), false);
});

test('corrupt and interrupted updates preserve the previous release', async t => {
  const { root, store, state } = await fixture(t);
  const first = await store.latest();
  state.release = release('0.3.2', Buffer.from('next package'));
  state.body = Buffer.from('bad package');
  assert.deepEqual(await store.latest(), first);
  assert.equal(JSON.parse(await readFile(resolve(root, 'latest.json'), 'utf8')).version, '0.3.1');
  assert.equal((await readdir(root)).some(name => name.endsWith('.partial')), false);
  state.fail = true;
  assert.deepEqual(await store.latest(), first);
});

test('cold failure is throttled and verified disk cache survives a restart', async t => {
  const { root, state, store } = await fixture(t);
  state.fail = true;
  await assert.rejects(store.latest());
  state.fail = false;
  const previous = await store.latest();
  const restored = new ReleaseStore({ repository: 'owner/private-addon', githubToken: '', cachePath: root });
  assert.deepEqual(await restored.latest(), previous);
  await writeFile(resolve(root, `${sha256}.zip`), 'corrupt disk file');
  const damaged = new ReleaseStore({ repository: 'owner/private-addon', githubToken: '', cachePath: root, refreshMs: 60_000 });
  await assert.rejects(damaged.latest());
  await assert.rejects(damaged.latest());
});

test('GitHub token never follows an asset redirect and foreign hosts are rejected', async t => {
  const calls = [];
  const { store } = await fixture(t, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/releases/latest')) return Response.json(release());
    if (url.includes('api.github.com')) return new Response(null, {
      status: 302, headers: { location: 'https://release-assets.githubusercontent.com/package' } });
    return new Response(packageBytes);
  } });
  await store.latest();
  assert.equal(calls[1].init.headers.Authorization, 'Bearer github_secret');
  assert.equal(calls[2].init.headers.Authorization, undefined);
  for (const url of ['http://api.github.com/package', 'https://evil.example/file',
    'https://githubusercontent.com.evil.example/file', 'https://api.github.com:8443/file',
    'https://user@api.github.com/file']) await assert.rejects(store.request(url, true));
});

test('API protects metadata and downloads, revokes devices live, and hides upstream errors', async t => {
  const { root, store, state } = await fixture(t, { refreshMs: 60_000 });
  const keysPath = resolve(root, 'devices.json');
  const registry = [{ name: 'computer', sha256: tokenDigest(token), revoked: false }];
  await writeFile(keysPath, JSON.stringify(registry));
  const server = createUpdateServer({ store, keysPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/releases/latest`)).status, 401);
  assert.equal((await fetch(`${base}/v1/packages/${sha256}.zip`)).status, 401);
  const manifest = await (await fetch(`${base}/v1/releases/latest`, { headers })).json();
  const download = await fetch(base + manifest.downloadPath, { headers });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), packageBytes);
  assert.equal((await fetch(`${base}/v1/packages/../../devices.json`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/v1/releases/latest?token=${token}`)).status, 401);
  for (let i = 0; i < 22; i++) await fetch(`${base}/v1/releases/latest`);
  assert.equal((await fetch(`${base}/v1/releases/latest`)).status, 429);
  assert.equal((await fetch(`${base}/v1/releases/latest`, { headers })).status, 200);
  registry[0].revoked = true;
  await writeFile(keysPath, JSON.stringify(registry));
  assert.equal((await fetch(`${base}/v1/releases/latest`, { headers })).status, 429);
  registry[0].revoked = false;
  await writeFile(keysPath, JSON.stringify(registry));
  state.fail = true;
  store.current = undefined;
  store.nextRefresh = 0;
  const failed = await fetch(`${base}/v1/releases/latest`, { headers });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'update_source_unavailable' });
});
