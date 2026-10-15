import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database, passwordHash } from '../server/database.mjs';
import { createPlatform } from '../server/index.mjs';
import { prepareGuides } from '../server/guides.mjs';

const source = (version = 1) => `#forever\n#group RestedXP Forever Guide (H)\n#name 22-24 Test\n#version ${version}\nstep\n.accept 123 >>Тест ${version}\n`;
const input = (version = 1) => ({ fileName: 'Guide.txt', content: source(version) });
function container(guides) {
  const text = 'example#12345', bytes = Buffer.from(text);
  const key = Array.from({ length: 16 }, (_, i) => bytes[(i - (16 - bytes.length)) & 15] ?? 0);
  for (let i = 0; i < 16; i++) key[(-i) & 15] = key[(15 - i) & 15] ^ key[(13 - i) & 15] ^ key[(12 - i) & 15] ^ key[(10 - i) & 15];
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i & 15]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0;
  j = 0;
  const compressed = deflateSync(Buffer.from(guides.join('\0')));
  const encrypted = compressed.map(byte => {
    i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 255];
  });
  return { fileName: 'Guide!example#12345.txt', content: `${guides.length}|${compressed.readUInt32BE(compressed.length - 4)}:${encrypted.toString('base64')}%|40000` };
}

test('guide uploads decode encrypted files, preserve text, and reject broken or executable input', () => {
  const pack = prepareGuides(container([source(), source().replace('22-24 Test', '24-26 Test')]));
  assert.equal(pack.name, 'Guide.txt'); assert.equal(pack.sectionCount, 2);
  assert.equal(JSON.parse(pack.content).guides[0], source().trimEnd().replaceAll('RestedXP', 'DiscodicXP') + '\n');
  assert.equal(pack.size, Buffer.byteLength(pack.content));
  assert.equal(pack.sha256, createHash('sha256').update(pack.content).digest('hex'));
  for (const value of [null, { ...input(), fileName: '../guide.txt' }, { ...input(), content: 'os.execute("bad")' },
    input(1).content.replace('step', '#code = function() end\nstep'), { ...input(), content: source().replace('#forever', '#classic') },
    { ...container([source()]), fileName: 'Guide!wrong#1234.txt' }, container([source(), source()]),
    { ...container([source()]), content: container([source()]).content.slice(0, -3) }]) {
    assert.throws(() => prepareGuides(typeof value === 'string' ? { ...input(), content: value } : value));
  }
});

test('guide revisions persist, unchanged uploads are idempotent, and history retains 20 versions', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-guides-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, 'database.sqlite');
  let db = new Database(path);
  try {
    const first = db.publishGuides(prepareGuides(input()));
    assert.equal(first.revision, 1);
    assert.equal(db.publishGuides(prepareGuides(input())).revision, 1);
    for (let i = 2; i <= 22; i++) db.publishGuides(prepareGuides(input(i)));
    assert.equal(db.overview().guides.length, 20);
    assert.equal(db.overview().guides.at(-1).revision, 3);
    db.close(); db = new Database(path);
    assert.equal(db.latestGuides().revision, 22);
    assert.equal(db.get('SELECT content FROM guidePackages WHERE revision=22').content, prepareGuides(input(22)).content);
  } finally { db.close(); }
});

test('admin upload and device downloads enforce sessions, CSRF and revoked keys without mutating progress', async t => {
  const db = new Database(':memory:');
  db.run('INSERT INTO admins VALUES(?,?)', 'admin', passwordHash('guide-test-password'));
  const account = db.createAccount('Test#1234'), device = db.createDevice(account.id, 'Computer');
  const server = createPlatform({ db, origin: 'http://127.0.0.1', store: {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(() => { db.close(); done(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path, { headers: { Authorization: `Bearer ${device.token}` } });
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'guide-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
  const headers = { Cookie: cookie, Origin: 'http://127.0.0.1', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const upload = (value, extra = {}) => fetch(base + '/api/admin/guides', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  assert.equal((await get('/api/v1/guides/latest')).status, 404);
  assert.equal((await upload(input(), { Cookie: '' })).status, 401);
  assert.equal((await upload(input(), { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await upload(input(), { Origin: 'https://foreign.example' })).status, 403);
  const published = await upload(container([source()]));
  assert.equal(published.status, 201);
  const first = await published.json();
  assert.equal((await get('/api/v1/guides/latest')).status, 200);
  await upload(input(2));
  const downloaded = await get(first.downloadPath);
  assert.equal(downloaded.status, 200);
  const content = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(createHash('sha256').update(content).digest('hex'), first.sha256);
  assert.equal(content.length, first.size);
  assert.equal((await upload({ ...input(), content: 'invalid' })).status, 400);
  assert.equal(db.latestGuides().revision, 2);
  assert.equal(db.get('SELECT count(*) count FROM characters').count, 0);
  assert.equal((await fetch(base + first.downloadPath)).status, 401);
  db.run('UPDATE devices SET revoked=1 WHERE id=?', device.id);
  assert.equal((await get(first.downloadPath)).status, 401);
});
