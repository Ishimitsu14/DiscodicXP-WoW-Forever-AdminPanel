import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const hashPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^v?(\d+\.\d+\.\d+)$/;

export function selectPackage(release, maxBytes) {
  const version = release.tag_name?.match(versionPattern)?.[1];
  if (!version || release.draft || release.prerelease) throw new Error('Unsupported release.');
  const assets = release.assets?.filter(asset => asset.name === `DiscodicXP-${version}-personal.zip`);
  if (assets?.length !== 1) throw new Error('Expected one addon package.');
  const asset = assets[0];
  const sha256 = asset.digest?.replace(/^sha256:/, '');
  if (!hashPattern.test(sha256 || '') || !Number.isSafeInteger(asset.id) || asset.id <= 0
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxBytes) {
    throw new Error('Invalid release asset.');
  }
  return { version, tag: release.tag_name, sha256, size: asset.size, assetId: asset.id };
}

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class ReleaseStore {
  constructor({ repository, githubToken, cachePath, fetchImpl = fetch, refreshMs = 120_000,
    maxBytes = 64 * 1024 * 1024, report = () => {} }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
    Object.assign(this, { repository, githubToken, fetchImpl, refreshMs, maxBytes, report });
    this.cachePath = resolve(cachePath);
    this.nextRefresh = 0;
  }

  async request(url, binary = false) {
    let target = new URL(url);
    for (let attempt = 0; attempt < 4; attempt++) {
      const isApi = target.hostname === 'api.github.com';
      if (target.protocol !== 'https:' || target.port || target.username || target.password
        || (!isApi && !target.hostname.endsWith('.githubusercontent.com'))) {
        throw new Error('Unexpected GitHub download host.');
      }
      const headers = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'User-Agent': 'DiscodicXP-Update-Service', 'X-GitHub-Api-Version': '2022-11-28' };
      if (isApi) headers.Authorization = `Bearer ${this.githubToken}`;
      const response = await this.fetchImpl(target.href, {
        headers, redirect: 'manual', signal: AbortSignal.timeout(binary ? 120_000 : 20_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!binary || !location) throw new Error('Unexpected GitHub redirect.');
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('GitHub request failed.');
      }
      return response;
    }
    throw new Error('Too many GitHub redirects.');
  }

  async restore() {
    try {
      const cached = JSON.parse(await readFile(resolve(this.cachePath, 'latest.json'), 'utf8'));
      if (!hashPattern.test(cached.sha256 || '') || !versionPattern.test(cached.version || '')
        || !Number.isSafeInteger(cached.size) || cached.size <= 0 || cached.size > this.maxBytes) return;
      const path = this.packagePath(cached.sha256);
      if ((await stat(path)).size === cached.size && await fileDigest(path) === cached.sha256) {
        this.current = cached;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.report('cache_restore_failed');
    }
  }

  packagePath(sha256) {
    if (!hashPattern.test(sha256)) throw new Error('Invalid package identifier.');
    return resolve(this.cachePath, `${sha256}.zip`);
  }

  async download(info) {
    const path = this.packagePath(info.sha256);
    try {
      if ((await stat(path)).size === info.size && await fileDigest(path) === info.sha256) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const response = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/assets/${info.assetId}`, true);
    const temporary = `${path}.partial`;
    const hash = createHash('sha256');
    let size = 0;
    const { open } = await import('node:fs/promises');
    const file = await open(temporary, 'w', 0o600);
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > info.size || size > this.maxBytes) throw new Error('Package too large.');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('Package integrity failed.');
      await file.close();
      await rename(temporary, path);
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async refresh() {
    await mkdir(this.cachePath, { recursive: true, mode: 0o700 });
    if (!this.restored) {
      await this.restore();
      this.restored = true;
    }
    if (!this.githubToken) throw new Error('GitHub access is not configured.');
    const response = await this.request(`https://api.github.com/repos/${this.repository}/releases/latest`);
    const info = selectPackage(await response.json(), this.maxBytes);
    await this.download(info);
    const manifest = { version: info.version, tag: info.tag, sha256: info.sha256, size: info.size,
      downloadPath: `/v1/packages/${info.sha256}.zip` };
    const manifestPath = resolve(this.cachePath, 'latest.json');
    await writeFile(`${manifestPath}.partial`, JSON.stringify(manifest) + '\n', { mode: 0o600 });
    await rename(`${manifestPath}.partial`, manifestPath);
    this.current = manifest;
    await this.prune().catch(() => this.report('cache_cleanup_failed'));
    return manifest;
  }

  async prune() {
    const packages = await Promise.all((await readdir(this.cachePath))
      .filter(name => /^[a-f0-9]{64}\.zip$/.test(name))
      .map(async name => ({ name, modified: (await stat(resolve(this.cachePath, name))).mtimeMs })));
    const previous = packages.filter(entry => entry.name !== `${this.current.sha256}.zip`)
      .sort((a, b) => b.modified - a.modified);
    for (const entry of previous.slice(1)) await unlink(resolve(this.cachePath, entry.name));
  }

  async latest() {
    if (this.pending) return this.pending;
    if (Date.now() < this.nextRefresh) {
      if (this.current) return this.current;
      throw new Error('Update source unavailable.');
    }
    this.nextRefresh = Date.now() + this.refreshMs;
    this.pending = this.refresh().catch(error => {
      this.report('release_refresh_failed');
      if (this.current) return this.current;
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
