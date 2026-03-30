import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createStorageMarkdown,
  defaultFileName,
  detectMimeType,
  encryptAudioBytes,
  sha256Hex,
  uploadFileToStorage,
} from '../src/storage.js';

test('storage helpers derive mime and markdown correctly', () => {
  assert.equal(detectMimeType('/tmp/test.png'), 'image/png');
  assert.equal(defaultFileName('/tmp/test.png'), 'test.png');
  assert.equal(createStorageMarkdown('abc-123', 'hello.png'), '![hello.png](storage://abc-123)');
  assert.equal(sha256Hex(new Uint8Array([1, 2, 3])), '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
});

test('uploadFileToStorage prepares, uploads, and completes storage object', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-ap-storage-'));
  const filePath = path.join(dir, 'tiny.txt');
  writeFileSync(filePath, 'hello');
  const calls = [];
  const client = {
    async prepareStorageObject(body) {
      calls.push(['prepare', body]);
      return { object_id: 'obj-1', upload_url: 'https://upload.test/obj-1' };
    },
    async uploadPreparedStorageObject(prepared, bytes, contentType) {
      calls.push(['upload', prepared.object_id, bytes.byteLength, contentType]);
      return { object_id: prepared.object_id };
    },
    async completeStorageObject(objectId, body) {
      calls.push(['complete', objectId, body]);
      return { object_id: objectId };
    },
  };
  const uploaded = await uploadFileToStorage(client, filePath, {
    ownerNpub: 'npub-owner',
    accessGroupIds: ['e32a9684-bdfe-4870-967b-8036ac0ad7d3'],
  });
  assert.equal(uploaded.object_id, 'obj-1');
  assert.deepEqual(calls[0][1].access_group_ids, ['e32a9684-bdfe-4870-967b-8036ac0ad7d3']);
  assert.equal(calls[0][1].owner_group_id, 'e32a9684-bdfe-4870-967b-8036ac0ad7d3');
  assert.equal(calls[1][1], 'obj-1');
  assert.equal(calls[2][1], 'obj-1');
  rmSync(dir, { recursive: true, force: true });
});

test('encryptAudioBytes returns ciphertext and media encryption metadata', async () => {
  const result = await encryptAudioBytes(new Uint8Array([1, 2, 3, 4]));
  assert.ok(result.encryptedBytes instanceof Uint8Array);
  assert.ok(result.encryptedBytes.byteLength > 0);
  assert.equal(result.mediaEncryption.scheme, 'aes-gcm');
  assert.ok(result.mediaEncryption.key_b64);
  assert.ok(result.mediaEncryption.iv_b64);
});
