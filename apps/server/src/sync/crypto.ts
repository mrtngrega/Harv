import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

// Chunks are gzipped JSON sealed with AES-256-GCM. The key lives only on the user's
// devices (~/.harv/sync.key, copied once by hand), so GitHub only ever sees noise.

const MAGIC = Buffer.from('HRV1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function newKey(): Buffer {
  return randomBytes(32);
}

export function loadKey(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('The sync key file is damaged (it should hold 32 bytes in base64).');
  return key;
}

export function saveKey(path: string, key: Buffer): void {
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 });
}

/** `label` (the chunk's path in the repo) is authenticated too, so a chunk can't be passed off as another. */
export function seal(key: Buffer, label: string, data: unknown): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(data))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Throws when the key is wrong or the chunk was changed. */
export function open<T>(key: Buffer, label: string, sealed: Buffer): T {
  if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a Harv sync chunk');
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString('utf8')) as T;
}
