import { randomBytes } from 'node:crypto';
import { chmod, chown, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { tokenDigest } from './updates.mjs';

const [command, name, output] = process.argv.slice(2);
const keysPath = process.env.DEVICE_KEYS_PATH || '/etc/discodicxp/devices.json';
if (!['add', 'revoke'].includes(command) || !/^[a-zA-Z0-9_-]{1,64}$/.test(name || '')
  || (command === 'add' && (!output || !isAbsolute(output)))) {
  console.error('Usage: node manage-devices.mjs add <device-name> <absolute-secret-output-path> | revoke <device-name>');
  process.exit(1);
}
const devices = JSON.parse(await readFile(keysPath, 'utf8'));
if (!Array.isArray(devices)) throw new Error('Invalid device registry.');
const device = devices.find(entry => entry.name === name);
if (command === 'revoke') {
  if (!device) throw new Error('Unknown device.');
  device.revoked = true;
} else {
  if (device) throw new Error('Device already exists. Use another name.');
  if (resolve(output) === resolve(keysPath)) throw new Error('Output must differ from registry.');
  const token = `dxp_${randomBytes(32).toString('base64url')}`;
  await writeFile(output, token + '\n', { flag: 'wx', mode: 0o600 });
  await chmod(output, 0o600);
  devices.push({ name, sha256: tokenDigest(token), createdAt: new Date().toISOString(), revoked: false });
}
const registry = await stat(keysPath);
await writeFile(`${keysPath}.partial`, JSON.stringify(devices, null, 2) + '\n', { mode: 0o640 });
if (process.platform !== 'win32') await chown(`${keysPath}.partial`, registry.uid, registry.gid);
await rename(`${keysPath}.partial`, keysPath);
console.log(command === 'add' ? 'Device added. Secret saved to the requested file.' : 'Device revoked.');
