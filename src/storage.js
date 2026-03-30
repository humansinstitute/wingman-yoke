import { basename, extname } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.webm', 'audio/webm'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.pdf', 'application/pdf'],
]);

const BROWSER_FRIENDLY_AUDIO = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
]);

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export function detectMimeType(filePath, fallback = 'application/octet-stream') {
  const ext = extname(String(filePath || '')).toLowerCase();
  return MIME_BY_EXT.get(ext) || fallback;
}

export function readFileBytes(filePath) {
  return new Uint8Array(readFileSync(filePath));
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function defaultFileName(filePath, fallbackPrefix = 'upload') {
  const base = basename(String(filePath || '').trim());
  if (base) return base;
  return `${fallbackPrefix}.bin`;
}

export function createStorageMarkdown(objectId, fileName = 'image') {
  const safeAlt = String(fileName || 'image').replace(/[\]\[]/g, '').trim() || 'image';
  return `![${safeAlt}](storage://${objectId})`;
}

export async function uploadFileToStorage(client, filePath, {
  ownerNpub,
  accessGroupIds = [],
  ownerGroupId = null,
  contentType = null,
  fileName = null,
} = {}) {
  const bytes = readFileBytes(filePath);
  const nextFileName = fileName || defaultFileName(filePath, 'upload');
  const nextContentType = contentType || detectMimeType(filePath);
  const body = {
    owner_npub: ownerNpub,
    content_type: nextContentType,
    size_bytes: bytes.byteLength,
    file_name: nextFileName,
    access_group_ids: accessGroupIds,
  };
  const resolvedOwnerGroupId = ownerGroupId || accessGroupIds[0] || null;
  if (resolvedOwnerGroupId) body.owner_group_id = resolvedOwnerGroupId;
  const prepared = await client.prepareStorageObject(body);
  await client.uploadPreparedStorageObject(prepared, bytes, nextContentType);
  await client.completeStorageObject(prepared.object_id, {
    size_bytes: bytes.byteLength,
    sha256_hex: sha256Hex(bytes),
  });
  return {
    ...prepared,
    object_id: prepared.object_id,
    size_bytes: bytes.byteLength,
    content_type: nextContentType,
    file_name: nextFileName,
    sha256_hex: sha256Hex(bytes),
  };
}

export async function encryptAudioBytes(bytes) {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const rawKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', key));
  return {
    encryptedBytes: new Uint8Array(ciphertext),
    mediaEncryption: {
      scheme: 'aes-gcm',
      key_b64: bytesToBase64(rawKey),
      iv_b64: bytesToBase64(iv),
    },
  };
}

export async function uploadEncryptedAudioToStorage(client, filePath, {
  ownerNpub,
  accessGroupIds = [],
  ownerGroupId = null,
  contentType = null,
  fileName = null,
} = {}) {
  const normalized = normalizeAudioInput(filePath, contentType);
  try {
    const plainBytes = readFileBytes(normalized.filePath);
    const encrypted = await encryptAudioBytes(plainBytes);
    const nextFileName = fileName || normalized.fileName || defaultFileName(normalized.filePath, 'voice-note');
    const nextContentType = normalized.contentType || detectMimeType(normalized.filePath, 'audio/webm');
    const body = {
      owner_npub: ownerNpub,
      content_type: nextContentType,
      size_bytes: encrypted.encryptedBytes.byteLength,
      file_name: nextFileName,
      access_group_ids: accessGroupIds,
    };
    const resolvedOwnerGroupId = ownerGroupId || accessGroupIds[0] || null;
    if (resolvedOwnerGroupId) body.owner_group_id = resolvedOwnerGroupId;
    const prepared = await client.prepareStorageObject(body);
    await client.uploadPreparedStorageObject(prepared, encrypted.encryptedBytes, nextContentType);
    await client.completeStorageObject(prepared.object_id, {
      size_bytes: encrypted.encryptedBytes.byteLength,
      sha256_hex: sha256Hex(encrypted.encryptedBytes),
    });
    return {
      ...prepared,
      object_id: prepared.object_id,
      size_bytes: encrypted.encryptedBytes.byteLength,
      content_type: nextContentType,
      file_name: nextFileName,
      sha256_hex: sha256Hex(encrypted.encryptedBytes),
      media_encryption: encrypted.mediaEncryption,
    };
  } finally {
    normalized.cleanup();
  }
}

function normalizeAudioInput(filePath, providedContentType = null) {
  const nextContentType = providedContentType || detectMimeType(filePath, 'audio/webm');
  const nextFileName = defaultFileName(filePath, 'voice-note');
  if (BROWSER_FRIENDLY_AUDIO.has(nextContentType)) {
    return {
      filePath,
      contentType: nextContentType,
      fileName: nextFileName,
      cleanup() {},
    };
  }
  if (nextContentType === 'audio/aiff') {
    const tmpDir = mkdtempSync(`${tmpdir()}/wm-ap-audio-`);
    const wavPath = `${tmpDir}/${basename(filePath, extname(filePath))}.wav`;
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', filePath, wavPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return {
      filePath: wavPath,
      contentType: 'audio/wav',
      fileName: `${basename(filePath, extname(filePath))}.wav`,
      cleanup() {
        rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }
  return {
    filePath,
    contentType: nextContentType,
    fileName: nextFileName,
    cleanup() {},
  };
}
