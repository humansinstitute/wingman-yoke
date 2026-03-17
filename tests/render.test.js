import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStorageLinks } from '../src/render.js';

test('resolveStorageLinks looks up storage metadata by UUID', async () => {
  const calls = [];
  const client = {
    async getStorageObject(objectId) {
      calls.push(objectId);
      return {
        object_id: objectId,
        file_name: 'voice-note.webm',
        content_type: 'audio/webm;codecs=opus',
        size_bytes: 42,
        content_url: `https://sb4.otherstuff.studio/api/v4/storage/${objectId}/content`,
        download_url: null,
        completed_at: '2026-03-17T00:00:00.000Z',
      };
    },
    getStorageContentUrl(objectId) {
      return `https://sb4.otherstuff.studio/api/v4/storage/${objectId}/content`;
    },
  };

  const resolved = await resolveStorageLinks(client, 'Listen: ![voice](storage://abc-123)');
  assert.deepEqual(calls, ['abc-123']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].object_id, 'abc-123');
  assert.equal(resolved[0].file_name, 'voice-note.webm');
  assert.equal(resolved[0].content_url, 'https://sb4.otherstuff.studio/api/v4/storage/abc-123/content');
});
