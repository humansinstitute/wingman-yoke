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

test('syncRecords prefers write_group_npub and signs group proof with keyEntry.secret', async () => {
  const sessionSecret = makeSecret();
  const groupSecret = makeSecret();
  const groupId = 'group-123';
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
      groupKeys: {
        get(groupRef) {
          return groupRef === groupId || groupRef === groupNpub ? { secret: groupSecret } : null;
        },
        getCurrent(groupRef) {
          return this.get(groupRef);
        },
      },
    });
    const result = await client.syncRecords([{
      record_id: 'x',
      write_group_id: groupId,
      write_group_npub: groupNpub,
    }]);
    assert.equal(result.synced, 1);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.records[0].write_group_id, undefined);
    assert.equal(body.records[0].write_group_npub, groupNpub);
    assert.ok(body.group_write_tokens[groupNpub]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGroups queries by member npub', async () => {
  const secret = makeSecret();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ groups: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const sessionNpub = makeNpub(secret);
    const client = new SuperbasedClient({
      config: {
        directHttpsUrl: 'https://sb4.otherstuff.studio',
        workspaceOwnerNpub: makeNpub(),
      },
      session: {
        secret,
        npub: sessionNpub,
      },
      groupKeys: new Map(),
    });
    await client.getGroups();
    assert.match(calls[0][0], new RegExp(`/api/v4/groups\\?npub=${encodeURIComponent(sessionNpub)}$`));
  } finally {
    global.fetch = originalFetch;
  }
});

test('rotateGroup posts a new epoch payload to the rotate endpoint', async () => {
  const secret = makeSecret();
  const groupId = 'group-rotate-1';
  const payload = {
    group_npub: makeNpub(),
    member_keys: [
      { member_npub: makeNpub(), wrapped_group_nsec: 'wrapped-1', wrapped_by_npub: makeNpub() },
    ],
  };
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ group_id: groupId, current_epoch: 2 }), {
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
    const result = await client.rotateGroup(groupId, payload);
    assert.equal(result.current_epoch, 2);
    assert.match(calls[0][0], new RegExp(`/api/v4/groups/${encodeURIComponent(groupId)}/rotate$`));
    assert.equal(calls[0][1].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0][1].body), payload);
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

test('storage object lookup uses UUID metadata endpoint', async () => {
  const secret = makeSecret();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({
      object_id: 'obj-2',
      content_url: 'https://sb4.otherstuff.studio/api/v4/storage/obj-2/content',
    }), {
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
    const storageObject = await client.getStorageObject('obj-2');
    assert.equal(storageObject.object_id, 'obj-2');
    assert.match(calls[0][0], /\/api\/v4\/storage\/obj-2$/);
  } finally {
    global.fetch = originalFetch;
  }
});
