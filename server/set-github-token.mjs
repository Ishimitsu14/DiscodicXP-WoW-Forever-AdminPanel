import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const configPath = '/etc/discodicxp/service.env';
let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!/^[a-zA-Z0-9_]{20,255}$/.test(token)) throw new Error('Invalid token format.');
const config = await readFile(configPath, 'utf8');
if (!/^GITHUB_TOKEN=.*$/m.test(config)) throw new Error('Missing token setting.');
await writeFile(`${configPath}.partial`, config.replace(/^GITHUB_TOKEN=.*$/m, `GITHUB_TOKEN=${token}`), { mode: 0o600 });
await chmod(`${configPath}.partial`, 0o600);
await rename(`${configPath}.partial`, configPath);
console.log('GitHub credential saved. Restart discodicxp-update to apply.');
