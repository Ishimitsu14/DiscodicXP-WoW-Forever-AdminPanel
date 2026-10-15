import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError, text } from './snapshot.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = () => `dxp_${randomBytes(32).toString('base64url')}`;
export const passwordHash = (password, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}

export class Database {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS admins (login TEXT PRIMARY KEY, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, battleTag TEXT NOT NULL COLLATE NOCASE UNIQUE, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id),
        guid TEXT NOT NULL, name TEXT NOT NULL, realm TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        guide TEXT NOT NULL DEFAULT '', step INTEGER NOT NULL DEFAULT 1, updatedAt TEXT, observedBattleTag TEXT,
        UNIQUE(accountId, guid));
      CREATE TABLE IF NOT EXISTS snapshots (characterId TEXT NOT NULL REFERENCES characters(id), revision INTEGER NOT NULL,
        content TEXT NOT NULL, deviceId TEXT NOT NULL REFERENCES devices(id), createdAt TEXT NOT NULL,
        PRIMARY KEY(characterId, revision));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, action TEXT NOT NULL, subject TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guidePackages (revision INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, sectionCount INTEGER NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL);`);
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  event(action, subject) { this.run('INSERT INTO events(action, subject, createdAt) VALUES(?,?,?)', action, subject, new Date().toISOString()); }
  createAccount(battleTag) {
    battleTag = text(battleTag);
    if (!/^.{2,32}#\d{3,10}$/u.test(battleTag)) throw new ApiError(400, 'invalid_battle_tag');
    if (this.get('SELECT id FROM accounts WHERE battleTag = ?', battleTag)) throw new ApiError(409, 'account_exists');
    const id = randomUUID();
    this.run('INSERT INTO accounts VALUES(?,?,?)', id, battleTag, new Date().toISOString());
    this.event('account_created', id);
    return { id, battleTag };
  }
  createDevice(accountId, name) {
    if (!this.get('SELECT id FROM accounts WHERE id = ?', accountId)) throw new ApiError(404, 'not_found');
    const id = randomUUID(), token = secret();
    this.run('INSERT INTO devices(id,accountId,name,hash,createdAt) VALUES(?,?,?,?,?)',
      id, accountId, text(name, 64), digest(token), new Date().toISOString());
    this.event('device_created', id);
    return { id, token };
  }
  device(header) {
    if (!/^Bearer dxp_[A-Za-z0-9_-]{43}$/.test(header || '')) return null;
    return this.get('SELECT id,accountId,name FROM devices WHERE hash = ? AND revoked = 0', digest(header.slice(7))) || null;
  }
  list(accountId) { return this.all('SELECT * FROM characters WHERE accountId = ? ORDER BY name, realm', accountId); }
  save(device, snapshot) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let character = this.get('SELECT * FROM characters WHERE accountId = ? AND guid = ?', device.accountId, snapshot.guid);
      if ((character?.revision || 0) !== snapshot.baseRevision) throw new ApiError(409, 'revision_conflict');
      if (!character) {
        if (this.get('SELECT count(*) count FROM characters WHERE accountId = ?', device.accountId).count >= 200) throw new ApiError(409, 'character_limit');
        character = { id: randomUUID(), revision: 0 };
        this.run('INSERT INTO characters(id,accountId,guid,name,realm) VALUES(?,?,?,?,?)',
          character.id, device.accountId, snapshot.guid, snapshot.name, snapshot.realm);
      }
      const revision = character.revision + 1, updatedAt = new Date().toISOString();
      this.run('INSERT INTO snapshots VALUES(?,?,?,?,?)', character.id, revision, snapshot.content, device.id, updatedAt);
      this.run('UPDATE characters SET name=?,realm=?,revision=?,guide=?,step=?,updatedAt=?,observedBattleTag=? WHERE id=?',
        snapshot.name, snapshot.realm, revision, snapshot.guide, snapshot.step, updatedAt, snapshot.observedBattleTag, character.id);
      this.run('DELETE FROM snapshots WHERE characterId=? AND revision <= ?', character.id, revision - 20);
      this.event('progress_uploaded', `${character.id}:${revision}`);
      this.db.exec('COMMIT');
      return this.get('SELECT * FROM characters WHERE id = ?', character.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot(accountId, id) {
    const character = this.get('SELECT * FROM characters WHERE id=? AND accountId=?', id, accountId);
    if (!character) throw new ApiError(404, 'not_found');
    const saved = this.get('SELECT content FROM snapshots WHERE characterId=? AND revision=?', id, character.revision);
    return { schemaVersion: 1, character, revision: character.revision, content: saved.content };
  }
  publishGuides(pack) {
    const current = this.latestGuides();
    if (current?.sha256 === pack.sha256) return current;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run('INSERT INTO guidePackages(name,sha256,size,sectionCount,content,createdAt) VALUES(?,?,?,?,?,?)',
        pack.name, pack.sha256, pack.size, pack.sectionCount, pack.content, new Date().toISOString());
      const latest = this.latestGuides();
      this.run('DELETE FROM guidePackages WHERE revision <= ?', latest.revision - 20);
      this.event('guides_published', String(latest.revision));
      this.db.exec('COMMIT');
      return latest;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  latestGuides() {
    const pack = this.get('SELECT revision,name,sha256,size,sectionCount,createdAt FROM guidePackages ORDER BY revision DESC LIMIT 1');
    return pack ? { ...pack, schemaVersion: 1, downloadPath: `/api/v1/guides/packages/${pack.sha256}` } : null;
  }
  overview() {
    return {
      accounts: this.all(`SELECT a.*, (SELECT count(*) FROM characters c WHERE c.accountId=a.id) characterCount,
        (SELECT count(*) FROM devices d WHERE d.accountId=a.id AND d.revoked=0) deviceCount FROM accounts a ORDER BY createdAt DESC`),
      devices: this.all('SELECT id,accountId,name,revoked,createdAt FROM devices ORDER BY createdAt DESC'),
      characters: this.all('SELECT c.*,a.battleTag FROM characters c JOIN accounts a ON a.id=c.accountId ORDER BY updatedAt DESC'),
      events: this.all('SELECT * FROM events ORDER BY id DESC LIMIT 30'),
      guides: this.all('SELECT revision,name,sha256,size,sectionCount,createdAt FROM guidePackages ORDER BY revision DESC')
    };
  }
  close() { this.db.close(); }
}
