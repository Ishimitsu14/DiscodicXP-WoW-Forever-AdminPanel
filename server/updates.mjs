import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ReleaseStore } from './releases.mjs';

export const tokenDigest = token => createHash('sha256').update(token).digest('hex');

export async function authorized(header, keysPath) {
  if (!/^Bearer dxp_[A-Za-z0-9_-]{43}$/.test(header || '')) return false;
  const digest = Buffer.from(tokenDigest(header.slice(7)), 'hex');
  const devices = JSON.parse(await readFile(keysPath, 'utf8'));
  return Array.isArray(devices) && devices.some(device => !device.revoked
    && /^[a-f0-9]{64}$/.test(device.sha256 || '')
    && timingSafeEqual(digest, Buffer.from(device.sha256, 'hex')));
}

export function createUpdateServer({ store, keysPath, maxDownloads = 3, route, authorize }) {
  let activeDownloads = 0;
  const failures = new Map();
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const address = request.socket.remoteAddress;
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    try {
      if (route && await route(request, response, json)) return;
      if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      if (request.url === '/health') return json(200, { status: 'ok' });
      if (!(authorize ? await authorize(request.headers.authorization) : await authorized(request.headers.authorization, keysPath))) {
        if ((failures.get(address)?.count || 0) >= 20) return json(429, { error: 'too_many_requests' });
        const entry = failures.get(address) || { count: 0, until: now + 60_000 };
        entry.count++;
        if (failures.size < 1024 || failures.has(address)) failures.set(address, entry);
        return json(401, { error: 'unauthorized' });
      }
      if (request.url === '/v1/releases/latest') return json(200, await store.latest());
      const packageId = request.url?.match(/^\/v1\/packages\/([a-f0-9]{64})\.zip$/)?.[1];
      if (!packageId) return json(404, { error: 'not_found' });
      if (activeDownloads >= maxDownloads) return json(429, { error: 'downloads_busy' });
      const path = store.packagePath(packageId);
      let size;
      try { size = (await stat(path)).size; }
      catch (error) {
        if (error.code === 'ENOENT') return json(404, { error: 'not_found' });
        throw error;
      }
      activeDownloads++;
      try {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size,
          'Content-Disposition': 'attachment; filename="DiscodicXP.zip"' });
        await pipeline(createReadStream(path), response);
      } finally { activeDownloads--; }
    } catch {
      if (!response.headersSent) json(503, { error: 'update_source_unavailable' });
      else response.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const store = new ReleaseStore({ repository: process.env.GITHUB_REPOSITORY || 'Ishimitsu14/DiscodicXP-WoW-Forever',
    githubToken: process.env.GITHUB_TOKEN, cachePath: process.env.CACHE_PATH || '/var/lib/discodicxp/cache',
    report: code => console.error(code) });
  const server = createUpdateServer({ store,
    keysPath: process.env.DEVICE_KEYS_PATH || '/etc/discodicxp/devices.json' });
  server.listen(port, '127.0.0.1', () => console.log(`Update service listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
