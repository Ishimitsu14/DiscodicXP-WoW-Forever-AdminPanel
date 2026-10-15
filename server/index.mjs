import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, digest, passwordMatches } from './database.mjs';
import { ApiError, text, validateSnapshot } from './snapshot.mjs';
import { authorized, createUpdateServer } from './updates.mjs';
import { ReleaseStore } from './releases.mjs';
import { maxGuideBytes, prepareGuides } from './guides.mjs';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const staticPaths = ['/', '/app.js', '/styles.css', '/favicon.svg'];

async function body(request, max = 3 * 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new ApiError(415, 'json_required');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new ApiError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json'); }
}

export function createPlatform({ db, origin, store, keysPath }) {
  const site = new URL(origin);
  if (site.origin !== origin || !['https:', 'http:'].includes(site.protocol)
    || (site.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP allowed on loopback).');
  const sessions = new Map(), attempts = new Map();
  const cookieName = 'dxp_session';
  function cookie(value, age) {
    return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${site.protocol === 'https:' ? '; Secure' : ''}`;
  }
  function session(request) {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const current = token && sessions.get(digest(token));
    if (!current || current.until <= Date.now()) throw new ApiError(401, 'unauthorized');
    return { ...current, key: digest(token) };
  }
  function limited(key, limit) {
    const now = Date.now();
    for (const [id, value] of attempts) if (value.until < now) attempts.delete(id);
    const entry = attempts.get(key) || { count: 0, until: now + 60000 };
    if (++entry.count > limit || attempts.size > 4096) throw new ApiError(429, 'too_many_requests');
    attempts.set(key, entry);
  }
  const server = createUpdateServer({ store, keysPath,
    authorize: async header => Boolean(db.device(header) || (keysPath && await authorized(header, keysPath))),
    route: async (request, response, json) => {
      const path = new URL(request.url, origin).pathname;
      if (!path.startsWith('/api/') && !staticPaths.includes(path)) return false;
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      response.setHeader('Referrer-Policy', 'no-referrer');
      try {
        if (request.method === 'GET' && staticPaths.includes(path)) {
          const file = path === '/' ? 'index.html' : path.slice(1);
          const bytes = await readFile(resolve(publicPath, file));
          response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
          response.end(bytes);
          return true;
        }
        if (path.startsWith('/api/admin/')) {
          for (const [key, value] of sessions) if (value.until < Date.now()) sessions.delete(key);
          if (request.method !== 'GET' && request.headers.origin !== origin) throw new ApiError(403, 'origin_rejected');
          if (path === '/api/admin/login' && request.method === 'POST') {
            limited('login:' + request.socket.remoteAddress, 10);
            limited('login-global', 60);
            const input = await body(request, 16384);
            const login = text(input.login, 64), password = text(input.password, 512);
            const admin = db.get('SELECT * FROM admins WHERE login = ?', login);
            if (!passwordMatches(password, admin?.password || '0:'.padEnd(130, '0')) || !admin) throw new ApiError(401, 'invalid_credentials');
            if (sessions.size >= 100) throw new ApiError(429, 'too_many_sessions');
            const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
            sessions.set(digest(token), { login, csrf, until: Date.now() + 8 * 3600000 });
            response.setHeader('Set-Cookie', cookie(token, 8 * 3600));
            db.event('admin_login', login);
            json(200, { login, csrf });
            return true;
          }
          const current = session(request);
          if (request.method !== 'GET' && request.headers['x-csrf-token'] !== current.csrf) throw new ApiError(403, 'csrf_rejected');
          if (path === '/api/admin/session' && request.method === 'GET') json(200, { login: current.login, csrf: current.csrf });
          else if (path === '/api/admin/logout' && request.method === 'POST') {
            sessions.delete(current.key);
            response.setHeader('Set-Cookie', cookie('', 0));
            json(200, { ok: true });
          } else if (path === '/api/admin/overview' && request.method === 'GET') json(200, db.overview());
          else if (path === '/api/admin/guides' && request.method === 'POST') {
            limited('guides:' + current.login, 10);
            json(201, db.publishGuides(prepareGuides(await body(request, maxGuideBytes * 2))));
          }
          else if (path === '/api/admin/accounts' && request.method === 'POST') json(201, db.createAccount((await body(request, 16384)).battleTag));
          else if (path === '/api/admin/devices' && request.method === 'POST') {
            const input = await body(request, 16384);
            json(201, db.createDevice(text(input.accountId), input.name));
          } else if (/^\/api\/admin\/devices\/[^/]+\/revoke$/.test(path) && request.method === 'POST') {
            const id = path.split('/')[4];
            if (!db.run('UPDATE devices SET revoked=1 WHERE id=?', id).changes) throw new ApiError(404, 'not_found');
            db.event('device_revoked', id);
            json(200, { ok: true });
          } else if (/^\/api\/admin\/characters\/[^/]+\/history$/.test(path) && request.method === 'GET') {
            json(200, db.all('SELECT revision,createdAt,deviceId FROM snapshots WHERE characterId=? ORDER BY revision DESC', path.split('/')[4]));
          } else throw new ApiError(404, 'not_found');
          return true;
        }
        const device = db.device(request.headers.authorization);
        limited('api:' + (device?.id || request.socket.remoteAddress), device ? 120 : 20);
        if (!device) throw new ApiError(401, 'unauthorized');
        if (path === '/api/v1/account' && request.method === 'GET') json(200, db.get('SELECT id,battleTag FROM accounts WHERE id=?', device.accountId));
        else if (path === '/api/v1/guides/latest' && request.method === 'GET') {
          const latest = db.latestGuides();
          if (!latest) throw new ApiError(404, 'guides_not_published');
          json(200, latest);
        } else if (/^\/api\/v1\/guides\/packages\/[a-f0-9]{64}$/.test(path) && request.method === 'GET') {
          const pack = db.get('SELECT content,size FROM guidePackages WHERE sha256=? ORDER BY revision DESC LIMIT 1', path.split('/')[5]);
          if (!pack) throw new ApiError(404, 'not_found');
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': pack.size });
          response.end(pack.content);
        }
        else if (path === '/api/v1/characters' && request.method === 'GET') json(200, db.list(device.accountId));
        else if (path === '/api/v1/snapshots' && request.method === 'POST') json(201, db.save(device, validateSnapshot(await body(request))));
        else if (/^\/api\/v1\/characters\/[^/]+\/snapshot$/.test(path) && request.method === 'GET') {
          const id = path.split('/')[4];
          json(200, db.snapshot(device.accountId, id));
          db.event('progress_downloaded', `${id}:${device.id}`);
        } else throw new ApiError(404, 'not_found');
      } catch (error) {
        json(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'internal_error' });
      }
      return true;
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const db = new Database(process.env.DATABASE_PATH || 'data/discodicxp.sqlite');
  const store = new ReleaseStore({ repository: process.env.GITHUB_REPOSITORY || 'Ishimitsu14/DiscodicXP-WoW-Forever',
    githubToken: process.env.GITHUB_TOKEN, cachePath: process.env.CACHE_PATH || 'data/cache', report: code => console.error(code) });
  const server = createPlatform({ db, store, keysPath: process.env.DEVICE_KEYS_PATH,
    origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}` });
  server.listen(port, '127.0.0.1', () => console.log(`DiscodicXP admin: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
