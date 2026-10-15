import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database, passwordHash } from '../server/database.mjs';
import { createPlatform } from '../server/index.mjs';
import { validateSnapshot } from '../server/snapshot.mjs';

const character = { guid: 'Player-1-ABC', name: 'Тест', realm: 'Хроми' };
const content = step => `DXPCData = {syncIdentity={guid="Player-1-ABC",name="Тест",realm="Хроми",battleTag="Test#1234"},
 currentGuideName="Маршрут",currentStep=${step},currentStepId="abc",guideProgress={["Маршрут"]={step=${step},stepId="abc"}},
 stepSkip={[2]=true},completedWaypoints={[12]=true}}
 DXPCTrackingData = {levels={[1]={xp=23.5}}} DXPCComms = nil DXPCSettings = {}`;
const snapshot = (step = 10, revision = 0) => ({ schemaVersion: 1, character, baseRevision: revision, content: content(step) });

async function fixture(t) {
  const db = new Database(':memory:');
  db.run('INSERT INTO admins VALUES(?,?)', 'admin', passwordHash('integration-test-password'));
  const account = db.createAccount('Test#1234'), other = db.createAccount('Other#1234');
  const first = db.createDevice(account.id, 'First'), second = db.createDevice(account.id, 'Second'), foreign = db.createDevice(other.id, 'Foreign');
  const server = createPlatform({ db, origin: 'http://127.0.0.1', store: { latest: async () => ({ version: '0.4.0' }) } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(() => { db.close(); done(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { token = first.token, value, method = value ? 'POST' : 'GET', ...rest } = {}) {
    return fetch(base + path, { method, ...rest, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...rest.headers },
      ...(value ? { body: JSON.stringify(value) } : {}) });
  }
  return { db, base, request, first, second, foreign };
}

test('snapshot validator accepts real character data and rejects code, wrong identities and excessive nesting', () => {
  const parsed = validateSnapshot(snapshot());
  assert.equal(parsed.name, 'Тест'); assert.equal(parsed.guide, 'Маршрут'); assert.equal(parsed.step, 10);
  assert.equal(parsed.observedBattleTag, 'Test#1234');
  for (const source of ['os.execute("bad")', content(2) + ' Evil={}', content(2) + ' DXPCData.x=2', content(2).replace('currentStep=2', 'currentStep=1+1'),
    content(2).replace('stepSkip={[2]=true}', 'stepSkip={value=' + '{'.repeat(80) + '}'.repeat(80) + '}')]) {
    assert.throws(() => validateSnapshot({ ...snapshot(), content: source }));
  }
  assert.throws(() => validateSnapshot({ ...snapshot(), character: { ...character, guid: 'Player-2-DEF' } }));
});

test('accounts, device hashes, revisions and saved progress survive a database restart', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'dxp-progress-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, 'progress.sqlite');
  let db = new Database(path);
  const account = db.createAccount('Persist#1234'), device = db.createDevice(account.id, 'Computer');
  const saved = db.save(db.device(`Bearer ${device.token}`), validateSnapshot(snapshot(22)));
  db.close();
  db = new Database(path);
  try {
    assert.equal(db.device(`Bearer ${device.token}`).accountId, account.id);
    assert.equal(db.snapshot(account.id, saved.id).content, content(22));
    assert.equal(db.list(account.id)[0].revision, 1);
  } finally { db.close(); }
});

test('two computers restore all per-character data, stale uploads conflict and foreign accounts are isolated', async t => {
  const { request, second, foreign, db } = await fixture(t);
  const upload = await request('/api/v1/snapshots', { value: snapshot() }); assert.equal(upload.status, 201);
  const saved = await upload.json(); assert.equal(saved.revision, 1);
  const listed = await (await request('/api/v1/characters', { token: second.token })).json(); assert.equal(listed[0].guid, character.guid);
  const restored = await (await request(`/api/v1/characters/${saved.id}/snapshot`, { token: second.token })).json();
  assert.equal(restored.content, content(10)); assert.equal(restored.schemaVersion, 1);
  assert.equal((await request('/api/v1/snapshots', { token: second.token, value: snapshot(15, 1) })).status, 201);
  assert.equal((await request('/api/v1/snapshots', { value: snapshot(11, 1) })).status, 409);
  assert.equal((await request(`/api/v1/characters/${saved.id}/snapshot`, { token: foreign.token })).status, 404);
  assert.deepEqual(await (await request('/api/v1/characters', { token: foreign.token })).json(), []);
  assert.equal(db.get('SELECT revision FROM characters WHERE id=?', saved.id).revision, 2);
  assert.equal((await request('/v1/releases/latest', { token: second.token })).status, 200);
});

test('parallel uploads use compare-and-swap and history is retained across revisions', async t => {
  const { request, db } = await fixture(t);
  const results = await Promise.all([request('/api/v1/snapshots', { value: snapshot() }), request('/api/v1/snapshots', { value: snapshot(11) })]);
  assert.deepEqual(results.map(item => item.status).sort(), [201, 409]);
  for (let revision = 1; revision < 23; revision++) assert.equal((await request('/api/v1/snapshots', { value: snapshot(revision + 20, revision) })).status, 201);
  assert.equal(db.get('SELECT count(*) count FROM snapshots').count, 20);
  assert.equal(db.get('SELECT min(revision) revision FROM snapshots').revision, 4);
});

test('admin session, CSRF, safe key responses, revocation and logout work end to end', async t => {
  const { request, first, db } = await fixture(t);
  assert.equal((await request('/api/admin/overview')).status, 401);
  assert.equal((await request('/api/admin/login', { value: { login: 'admin', password: 'wrong' }, headers: { Origin: 'http://127.0.0.1' } })).status, 401);
  const login = await request('/api/admin/login', { value: { login: 'admin', password: 'integration-test-password' }, headers: { Origin: 'http://127.0.0.1' } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
  const headers = { Cookie: cookie, Origin: 'http://127.0.0.1', 'X-CSRF-Token': csrf };
  assert.equal((await request('/api/admin/accounts', { value: { battleTag: 'New#1234' }, headers: { ...headers, 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await request('/api/admin/accounts', { value: { battleTag: 'New#1234' }, headers })).status, 201);
  const overview = await (await request('/api/admin/overview', { headers })).json();
  assert.equal(JSON.stringify(overview).includes(first.token), false); assert.equal(JSON.stringify(overview).includes('"hash"'), false);
  assert.equal((await request(`/api/admin/devices/${first.id}/revoke`, { value: {}, headers })).status, 200);
  assert.equal((await request('/api/v1/characters')).status, 401);
  assert.equal((await request('/v1/releases/latest')).status, 401);
  assert.equal(db.get('SELECT revoked FROM devices WHERE id=?', first.id).revoked, 1);
  assert.equal((await request('/api/admin/logout', { value: {}, headers })).status, 200);
  assert.equal((await request('/api/admin/overview', { headers })).status, 401);
});

test('request boundaries reject executable snapshots, wrong origins, unsupported media and unauthenticated requests', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/v1/snapshots', { value: { ...snapshot(), content: 'os.execute("bad")' } })).status, 400);
  assert.equal((await request('/api/v1/snapshots', { token: 'bad', value: snapshot() })).status, 401);
  assert.equal((await request('/api/v1/snapshots', { value: snapshot(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/admin/login', { value: { login: 'admin', password: 'integration-test-password' }, headers: { Origin: 'https://foreign.example' } })).status, 403);
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/health')).status, 200);
});
