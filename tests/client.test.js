import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { SuperbasedClient } from '../src/client.js';

function makeSecret() {
  return generateSecretKey();
}

function makeNpub(secret = makeSecret()) {
  return nip19.npubEncode(getPublicKey(secret));
}

test('syncRecords signs group proof with keyEntry.secret', async () => {
  const sessionSecret = makeSecret();
  const groupSecret = makeSecret();
  const groupNpub = makeNpub(groupSecret);
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ synced: 1, created: 1, updated: 0, rejected: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = new SuperbasedClient({
      config: {
        directHttpsUrl: 'https://sb4.otherstuff.studio',
        workspaceOwnerNpub: makeNpub(),
      },
      session: {
        secret: sessionSecret,
        npub: makeNpub(sessionSecret),
      },
      groupKeys: new Map([
        [groupNpub, { secret: groupSecret }],
      ]),
    });
    const result = await client.syncRecords([{
      record_id: 'x',
      write_group_npub: groupNpub,
    }]);
    assert.equal(result.synced, 1);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0][1].body);
    assert.ok(body.group_write_tokens[groupNpub]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('storage helpers on client use prepare/complete endpoints', async () => {
  const secret = makeSecret();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ ok: true, object_id: 'obj-1', upload_url: 'https://upload.test/obj-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = new SuperbasedClient({
      config: {
        directHttpsUrl: 'https://sb4.otherstuff.studio',
        workspaceOwnerNpub: makeNpub(),
      },
      session: {
        secret,
        npub: makeNpub(secret),
      },
      groupKeys: new Map(),
    });
    await client.prepareStorageObject({ owner_npub: 'npub-owner', content_type: 'text/plain', size_bytes: 5 });
    await client.completeStorageObject('obj-1', { size_bytes: 5 });
    assert.match(calls[0][0], /\/api\/v4\/storage\/prepare$/);
    assert.match(calls[1][0], /\/api\/v4\/storage\/obj-1\/complete$/);
  } finally {
    global.fetch = originalFetch;
  }
});
