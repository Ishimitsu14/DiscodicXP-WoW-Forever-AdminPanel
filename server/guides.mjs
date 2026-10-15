import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';
import { ApiError } from './snapshot.mjs';

export const maxGuideBytes = 16 * 1024 * 1024;
const maxSections = 1000;

function adler32(bytes) {
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return (b * 65536 + a) >>> 0;
}

function decode(content, fileName) {
  const identity = fileName.match(/!([^!]+#\d+)\.txt$/i)?.[1];
  if (!identity) throw new Error('invalid_guide_filename');
  const text = identity.toLowerCase().slice(-16), bytes = Buffer.from(text, 'utf8');
  if (bytes.length !== text.length || !text.includes('#')) throw new Error('invalid_guide_filename');
  const key = Array.from({ length: 16 }, (_, i) => bytes[(i - (16 - bytes.length)) & 15] ?? 0);
  for (let i = 0; i < 16; i++) key[(-i) & 15] = key[(15 - i) & 15] ^ key[(13 - i) & 15] ^ key[(12 - i) & 15] ^ key[(10 - i) & 15];
  const header = content.match(/^(\d+)\|/), version = content.match(/%\|40000$/);
  if (!header || !version || Number(header[1]) < 1 || Number(header[1]) > maxSections) throw new Error('invalid_guide');
  const body = content.slice(header[0].length, version.index + 1), pattern = /(-?\d+):([A-Za-z0-9+/=]+)%/gy;
  const guides = [];
  let offset = 0, total = 0;
  while (offset < body.length) {
    pattern.lastIndex = offset;
    const block = pattern.exec(body);
    if (!block) throw new Error('invalid_guide');
    const encrypted = Buffer.from(block[2], 'base64');
    if (encrypted.toString('base64') !== block[2]) throw new Error('invalid_guide');
    const state = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + state[i] + key[i & 15]) & 255;
      [state[i], state[j]] = [state[j], state[i]];
    }
    let i = 0;
    j = 0;
    const compressed = encrypted.map(byte => {
      i = (i + 1) & 255; j = (j + state[i]) & 255;
      [state[i], state[j]] = [state[j], state[i]];
      return byte ^ state[(state[i] + state[j]) & 255];
    });
    const checksum = Number(block[1]) >>> 0;
    if (compressed.length < 8 || compressed.readUInt32BE(compressed.length - 4) !== checksum) throw new Error('invalid_guide');
    const plain = inflateSync(compressed, { maxOutputLength: maxGuideBytes - total });
    total += plain.length;
    if (adler32(plain) !== checksum) throw new Error('invalid_guide');
    guides.push(...new TextDecoder('utf-8', { fatal: true }).decode(plain).split('\0').filter(Boolean));
    if (guides.length > maxSections) throw new Error('invalid_guide');
    offset = pattern.lastIndex;
  }
  if (guides.length !== Number(header[1])) throw new Error('invalid_guide');
  return guides;
}

export function prepareGuides(input) {
  if (!input || typeof input.fileName !== 'string' || input.fileName.length > 512
    || !/\.txt$/i.test(input.fileName) || basename(input.fileName.replaceAll('\\', '/')) !== input.fileName
    || /[\x00-\x1f]/.test(input.fileName) || typeof input.content !== 'string'
    || Buffer.byteLength(input.content) > maxGuideBytes) throw new ApiError(400, 'invalid_guide');
  let guides;
  try {
    const source = input.content.replace(/^\uFEFF/, '').trim();
    guides = source.startsWith('#') ? [source] : decode(source, input.fileName);
  } catch (error) { throw new ApiError(400, error.message === 'invalid_guide_filename' ? error.message : 'invalid_guide'); }
  const seen = new Set();
  guides = guides.map(source => {
    const value = source.replaceAll('\r\n', '\n').replaceAll('RXPGuides', 'DiscodicXP').replaceAll('RXPG', 'DXPG')
      .replaceAll('RXP', 'DXP').replaceAll('rxpguides', 'discodicxp').replaceAll('rxpg', 'dxpg').replaceAll('rxp', 'dxp').replaceAll('RestedXP', 'DiscodicXP');
    const name = value.match(/^#name\s+([^\r\n]+)/m)?.[1]?.trim(), group = value.match(/^#group\s+([^\r\n]+)/m)?.[1]?.trim();
    if (!name || !group || !/^\s*step(?:\s|$)/m.test(value) || !/^#forever\s*$/im.test(value)
      || /\0|^\s*#\S+\s*=/m.test(value) || seen.has(`${group}||${name}`)) throw new ApiError(400, 'invalid_guide');
    seen.add(`${group}||${name}`);
    return value;
  });
  const content = JSON.stringify({ schemaVersion: 1, guides });
  const size = Buffer.byteLength(content);
  if (size > maxGuideBytes || !guides.length) throw new ApiError(400, 'invalid_guide');
  const name = input.fileName.replace(/![^!]*\.txt$/i, '.txt');
  return { name, content, size, sectionCount: guides.length, sha256: createHash('sha256').update(content).digest('hex') };
}
