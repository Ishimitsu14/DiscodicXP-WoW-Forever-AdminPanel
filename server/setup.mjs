import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Database, passwordHash } from './database.mjs';
import { text } from './snapshot.mjs';

const path = process.argv[2];
let input;
if (path === '--stdin') {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new Error('Credentials input is too large.');
    chunks.push(chunk);
  }
  const parts = Buffer.concat(chunks).toString('utf8').split('\0');
  if (parts.length !== 2) throw new Error('Invalid credentials input.');
  input = { login: parts[0], password: parts[1] };
} else {
  if (!path || !isAbsolute(path)) throw new Error('Usage: npm run setup -- <absolute-credentials-path> | --stdin');
  try { input = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot read a valid credentials JSON file.'); }
}
const login = text(input.login, 64), password = text(input.password, 512);
if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
const db = new Database(process.env.DATABASE_PATH || 'data/discodicxp.sqlite');
try {
  if (db.get('SELECT login FROM admins WHERE login=?', login)) throw new Error('Admin already exists.');
  db.run('INSERT INTO admins VALUES(?,?)', login, passwordHash(password));
  console.log(path === '--stdin' ? 'Admin created.' : 'Admin created. Remove the local credentials file.');
} finally { db.close(); }
