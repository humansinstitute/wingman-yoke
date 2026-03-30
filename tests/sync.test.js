import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

function makeSession() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    secret,
    npub: nip19.npubEncode(pubkey),
  };
}

function makeNpub(secret = generateSecretKey()) {
  return nip19.npubEncode(getPublicKey(secret));
}

async function loadModules(tag) {
  const suffix = `?test=${tag}`;
  const db = await import(`../src/db.js${suffix}`);
  const sync = await import(`../src/sync.js${suffix}`);
  const nostr = await import(`../src/nostr.js${suffix}`);
  const translators = await import(`../src/translators.js${suffix}`);
  return { ...db, ...sync, ...nostr, ...translators };
}

function makeWrappedKeyRow(session, { groupId, groupSecret = generateSecretKey(), keyVersion = 1 }) {
  return {
    group_id: groupId,
    group_npub: makeNpub(groupSecret),
    key_version: keyVersion,
    wrapped_group_nsec: nip19.nsecEncode(groupSecret),
    wrapped_by_npub: session.npub,
  };
}

test('syncWorkspace preserves an existing task cursor when no records are applied', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-sync-empty-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-empty`;
  const { openDb, putMeta, getMeta, syncWorkspace } = await loadModules(tag);

  const previousCursor = '2026-03-28T05:00:00.000Z';
  const db = openDb();
  putMeta(db, 'sync:task:at', previousCursor);
  db.close();

  const session = makeSession();
  const config = { appNpub: 'npub1app' };
  const client = {
    async getGroups() { return { groups: [] }; },
    async getGroupKeys() { return { keys: [] }; },
    async fetchRecords() { return { records: [] }; },
  };

  await syncWorkspace({ client, config, session, quiet: true });

  const verifyDb = openDb();
  assert.equal(getMeta(verifyDb, 'sync:task:at'), previousCursor);
  verifyDb.close();

  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test('syncWorkspace advances the task cursor to the newest applied record timestamp', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-sync-task-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-task`;
  const {
    openDb,
    getMeta,
    syncWorkspace,
    decodeNsec,
    encryptForNpub,
    loadGroupKeyMap,
    outboundTask,
  } = await loadModules(tag);

  const session = makeSession();
  const ownerNpub = makeNpub();
  const groupId = 'group-task';
  const groupSecret = generateSecretKey();
  const wrappedKey = {
    group_id: groupId,
    group_npub: makeNpub(groupSecret),
    key_version: 1,
    wrapped_group_nsec: encryptForNpub(session.secret, session.npub, nip19.nsecEncode(groupSecret)),
    wrapped_by_npub: session.npub,
  };
  const groupKeys = loadGroupKeyMap(session, [wrappedKey], decodeNsec);
  const taskRecord = outboundTask('npub1app', session, groupKeys, {
    record_id: 'task-sync-test',
    owner_npub: ownerNpub,
    title: 'Synced task',
    description: '',
    assigned_to_npub: session.npub,
    board_group_id: groupId,
    group_ids: [groupId],
    shares: [{ type: 'group', key: groupId, group_id: groupId, group_npub: wrappedKey.group_npub, access: 'write', label: 'Shared' }],
    version: 0,
  });
  taskRecord.updated_at = '2026-03-28T04:15:00.000Z';
  taskRecord.created_at = taskRecord.updated_at;

  const config = { appNpub: 'npub1app' };
  const client = {
    async getGroups() {
      return {
        groups: [{
          id: groupId,
          group_npub: wrappedKey.group_npub,
          current_epoch: 1,
          owner_npub: ownerNpub,
          name: 'Shared',
          members: [session.npub],
        }],
      };
    },
    async getGroupKeys() {
      return { keys: [wrappedKey] };
    },
    async fetchRecords(hash) {
      return hash.endsWith(':task') ? { records: [taskRecord] } : { records: [] };
    },
  };

  const counts = await syncWorkspace({ client, config, session, quiet: true });
  assert.equal(counts.task, 1);

  const verifyDb = openDb();
  const taskRow = verifyDb.prepare(`SELECT record_id, title, updated_at FROM tasks WHERE record_id = ?`).get('task-sync-test');
  assert.deepEqual(taskRow, {
    record_id: 'task-sync-test',
    title: 'Synced task',
    updated_at: taskRecord.updated_at,
  });
  assert.equal(getMeta(verifyDb, 'sync:task:at'), taskRecord.updated_at);
  verifyDb.close();

  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});
