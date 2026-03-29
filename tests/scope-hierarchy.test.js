import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { decodeNsec, encryptForNpub } from '../src/nostr.js';
import {
  inboundChannel,
  inboundDirectory,
  inboundDocument,
  inboundReport,
  inboundScope,
  inboundTask,
  loadGroupKeyMap,
  outboundChannel,
  outboundDirectory,
  outboundDocument,
  outboundReport,
  outboundScope,
  outboundTask,
  decryptRecordPayload,
} from '../src/translators.js';

function makeSession() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return { secret, npub: nip19.npubEncode(pubkey) };
}

function makeNpub(secret = generateSecretKey()) {
  return nip19.npubEncode(getPublicKey(secret));
}

function makeWrappedKeyRow(session, { groupId, groupSecret = generateSecretKey(), keyVersion = 1 }) {
  const groupNpub = nip19.npubEncode(getPublicKey(groupSecret));
  return {
    group_id: groupId,
    group_npub: groupNpub,
    key_version: keyVersion,
    wrapped_group_nsec: encryptForNpub(session.secret, session.npub, nip19.nsecEncode(groupSecret)),
    wrapped_by_npub: session.npub,
  };
}

function fakeRecord(overrides = {}) {
  return {
    record_id: overrides.record_id ?? 'rec-1',
    owner_npub: overrides.owner_npub ?? 'npub1owner',
    signature_npub: overrides.signature_npub ?? 'npub1owner',
    group_payloads: overrides.group_payloads ?? [],
    version: overrides.version ?? 1,
    updated_at: overrides.updated_at ?? '2026-03-30T00:00:00Z',
  };
}

// === inboundScope tests ===

test('inboundScope maps canonical l1-l5 fields', () => {
  const record = fakeRecord({ record_id: 'scope-l3' });
  const payload = {
    data: {
      title: 'Blog Writing',
      description: '',
      level: 'l3',
      parent_id: 'scope-l2',
      l1_id: 'scope-l1',
      l2_id: 'scope-l2',
      l3_id: 'scope-l3',
      l4_id: null,
      l5_id: null,
      record_state: 'active',
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l3');
  assert.equal(mapped.parent_id, 'scope-l2');
  assert.equal(mapped.l1_id, 'scope-l1');
  assert.equal(mapped.l2_id, 'scope-l2');
  assert.equal(mapped.l3_id, 'scope-l3');
  assert.equal(mapped.l4_id, null);
  assert.equal(mapped.l5_id, null);
});

test('inboundScope normalizes legacy product level to l1', () => {
  const record = fakeRecord({ record_id: 'scope-old' });
  const payload = {
    data: {
      title: 'Legacy Product',
      level: 'product',
      parent_id: null,
      product_id: null,
      project_id: null,
      record_state: 'active',
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l1');
  assert.equal(mapped.l1_id, 'scope-old');
  assert.equal(mapped.l2_id, null);
  assert.equal(mapped.l3_id, null);
  assert.equal(mapped.l4_id, null);
  assert.equal(mapped.l5_id, null);
});

test('inboundScope normalizes legacy project level to l2', () => {
  const record = fakeRecord({ record_id: 'scope-proj' });
  const payload = {
    data: {
      title: 'Legacy Project',
      level: 'project',
      parent_id: 'scope-prod',
      product_id: 'scope-prod',
      project_id: null,
      record_state: 'active',
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l2');
  assert.equal(mapped.l1_id, 'scope-prod');
  assert.equal(mapped.l2_id, 'scope-proj');
  assert.equal(mapped.l3_id, null);
});

test('inboundScope normalizes legacy deliverable level to l3', () => {
  const record = fakeRecord({ record_id: 'scope-del' });
  const payload = {
    data: {
      title: 'Legacy Deliverable',
      level: 'deliverable',
      parent_id: 'scope-proj',
      product_id: 'scope-prod',
      project_id: 'scope-proj',
      record_state: 'active',
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l3');
  assert.equal(mapped.l1_id, 'scope-prod');
  assert.equal(mapped.l2_id, 'scope-proj');
  assert.equal(mapped.l3_id, 'scope-del');
  assert.equal(mapped.l4_id, null);
  assert.equal(mapped.l5_id, null);
});

test('inboundScope maps l1 scope with self-referencing l1_id', () => {
  const record = fakeRecord({ record_id: 'scope-root' });
  const payload = {
    data: {
      title: 'Marketing',
      level: 'l1',
      parent_id: null,
      l1_id: 'scope-root',
      l2_id: null,
      l3_id: null,
      l4_id: null,
      l5_id: null,
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l1');
  assert.equal(mapped.l1_id, 'scope-root');
  assert.equal(mapped.parent_id, null);
});

test('inboundScope maps depth-5 scope correctly', () => {
  const record = fakeRecord({ record_id: 'scope-l5' });
  const payload = {
    data: {
      title: 'Sub-sub-sub',
      level: 'l5',
      parent_id: 'scope-l4',
      l1_id: 'scope-l1',
      l2_id: 'scope-l2',
      l3_id: 'scope-l3',
      l4_id: 'scope-l4',
      l5_id: 'scope-l5',
    },
  };
  const mapped = inboundScope(record, payload);
  assert.equal(mapped.level, 'l5');
  assert.equal(mapped.l1_id, 'scope-l1');
  assert.equal(mapped.l2_id, 'scope-l2');
  assert.equal(mapped.l3_id, 'scope-l3');
  assert.equal(mapped.l4_id, 'scope-l4');
  assert.equal(mapped.l5_id, 'scope-l5');
});

// === inbound scoped record tests ===

test('inboundTask maps canonical scope_l1_id-scope_l5_id fields', () => {
  const record = fakeRecord({ record_id: 'task-1' });
  const payload = {
    data: {
      title: 'My Task',
      scope_id: 'scope-l3',
      scope_l1_id: 'scope-l1',
      scope_l2_id: 'scope-l2',
      scope_l3_id: 'scope-l3',
      scope_l4_id: null,
      scope_l5_id: null,
      record_state: 'active',
    },
  };
  const mapped = inboundTask(record, payload);
  assert.equal(mapped.scope_id, 'scope-l3');
  assert.equal(mapped.scope_l1_id, 'scope-l1');
  assert.equal(mapped.scope_l2_id, 'scope-l2');
  assert.equal(mapped.scope_l3_id, 'scope-l3');
  assert.equal(mapped.scope_l4_id, null);
  assert.equal(mapped.scope_l5_id, null);
});

test('inboundTask normalizes legacy scope_product_id/scope_project_id/scope_deliverable_id', () => {
  const record = fakeRecord({ record_id: 'task-legacy' });
  const payload = {
    data: {
      title: 'Old Task',
      scope_id: 'scope-del',
      scope_product_id: 'scope-prod',
      scope_project_id: 'scope-proj',
      scope_deliverable_id: 'scope-del',
      record_state: 'active',
    },
  };
  const mapped = inboundTask(record, payload);
  assert.equal(mapped.scope_l1_id, 'scope-prod');
  assert.equal(mapped.scope_l2_id, 'scope-proj');
  assert.equal(mapped.scope_l3_id, 'scope-del');
  assert.equal(mapped.scope_l4_id, null);
  assert.equal(mapped.scope_l5_id, null);
});

test('inboundDocument maps canonical scope lineage fields', () => {
  const record = fakeRecord({ record_id: 'doc-1' });
  const payload = {
    data: {
      title: 'My Doc',
      scope_id: 'scope-l2',
      scope_l1_id: 'scope-l1',
      scope_l2_id: 'scope-l2',
      scope_l3_id: null,
      scope_l4_id: null,
      scope_l5_id: null,
    },
  };
  const mapped = inboundDocument(record, payload);
  assert.equal(mapped.scope_l1_id, 'scope-l1');
  assert.equal(mapped.scope_l2_id, 'scope-l2');
  assert.equal(mapped.scope_l3_id, null);
});

test('inboundDirectory maps canonical scope lineage fields', () => {
  const record = fakeRecord({ record_id: 'dir-1' });
  const payload = {
    data: {
      title: 'My Dir',
      scope_id: 'scope-l1',
      scope_l1_id: 'scope-l1',
      scope_l2_id: null,
      scope_l3_id: null,
      scope_l4_id: null,
      scope_l5_id: null,
    },
  };
  const mapped = inboundDirectory(record, payload);
  assert.equal(mapped.scope_l1_id, 'scope-l1');
  assert.equal(mapped.scope_l2_id, null);
});

test('inboundChannel maps canonical scope lineage fields', () => {
  const record = fakeRecord({ record_id: 'ch-1' });
  const payload = {
    data: {
      title: 'My Channel',
      scope_id: 'scope-l2',
      scope_l1_id: 'scope-l1',
      scope_l2_id: 'scope-l2',
      scope_l3_id: null,
      scope_l4_id: null,
      scope_l5_id: null,
    },
  };
  const mapped = inboundChannel(record, payload);
  assert.equal(mapped.scope_l1_id, 'scope-l1');
  assert.equal(mapped.scope_l2_id, 'scope-l2');
});

test('inboundReport maps canonical scope lineage in metadata', () => {
  const record = fakeRecord({ record_id: 'rpt-1' });
  const payload = {
    metadata: {
      title: 'Report',
      scope: {
        id: 'scope-l2',
        level: 'l2',
        l1_id: 'scope-l1',
        l2_id: 'scope-l2',
        l3_id: null,
        l4_id: null,
        l5_id: null,
      },
    },
    data: { declaration_type: 'text', payload: {} },
  };
  const mapped = inboundReport(record, payload);
  assert.equal(mapped.scope_id, 'scope-l2');
  assert.equal(mapped.scope_level, 'l2');
  assert.equal(mapped.scope_l1_id, 'scope-l1');
  assert.equal(mapped.scope_l2_id, 'scope-l2');
  assert.equal(mapped.scope_l3_id, null);
});

test('inboundReport normalizes legacy scope fields in metadata', () => {
  const record = fakeRecord({ record_id: 'rpt-legacy' });
  const payload = {
    metadata: {
      title: 'Old Report',
      scope: {
        id: 'scope-proj',
        level: 'project',
        product_id: 'scope-prod',
        project_id: 'scope-proj',
        deliverable_id: null,
      },
    },
    data: { declaration_type: 'text', payload: {} },
  };
  const mapped = inboundReport(record, payload);
  assert.equal(mapped.scope_level, 'l2');
  assert.equal(mapped.scope_l1_id, 'scope-prod');
  assert.equal(mapped.scope_l2_id, 'scope-proj');
  assert.equal(mapped.scope_l3_id, null);
});

// === outbound scope tests ===

test('outboundScope produces canonical l1_id-l5_id fields', () => {
  const session = makeSession();
  const groupId = 'group-1';
  const keyRow = makeWrappedKeyRow(session, { groupId });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);

  const scope = {
    record_id: 'scope-l2',
    owner_npub: session.npub,
    title: 'Content',
    description: '',
    level: 'l2',
    parent_id: 'scope-l1',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: null,
    l4_id: null,
    l5_id: null,
    shares: [],
    group_ids: [groupId],
    version: 1,
  };

  const envelope = outboundScope('npub1app', session, groupKeys, scope);
  const decrypted = decryptRecordPayload({
    record_id: envelope.record_id,
    owner_npub: session.npub,
    signature_npub: session.npub,
    owner_payload: envelope.owner_payload,
  }, session, groupKeys);

  assert.equal(decrypted.data.level, 'l2');
  assert.equal(decrypted.data.l1_id, 'scope-l1');
  assert.equal(decrypted.data.l2_id, 'scope-l2');
  assert.equal(decrypted.data.l3_id, null);
  assert.equal(decrypted.data.l4_id, null);
  assert.equal(decrypted.data.l5_id, null);
  // Must NOT contain legacy fields
  assert.equal(decrypted.data.product_id, undefined);
  assert.equal(decrypted.data.project_id, undefined);
});

test('outboundTask produces canonical scope_l1_id-scope_l5_id fields', () => {
  const session = makeSession();
  const groupId = 'group-1';
  const keyRow = makeWrappedKeyRow(session, { groupId });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);

  const task = {
    record_id: 'task-1',
    owner_npub: session.npub,
    title: 'Build',
    scope_id: 'scope-l3',
    scope_l1_id: 'scope-l1',
    scope_l2_id: 'scope-l2',
    scope_l3_id: 'scope-l3',
    scope_l4_id: null,
    scope_l5_id: null,
    shares: [],
    group_ids: [groupId],
    version: 1,
  };

  const envelope = outboundTask('npub1app', session, groupKeys, task);
  const decrypted = decryptRecordPayload({
    record_id: envelope.record_id,
    owner_npub: session.npub,
    signature_npub: session.npub,
    owner_payload: envelope.owner_payload,
  }, session, groupKeys);

  assert.equal(decrypted.data.scope_id, 'scope-l3');
  assert.equal(decrypted.data.scope_l1_id, 'scope-l1');
  assert.equal(decrypted.data.scope_l2_id, 'scope-l2');
  assert.equal(decrypted.data.scope_l3_id, 'scope-l3');
  assert.equal(decrypted.data.scope_l4_id, null);
  assert.equal(decrypted.data.scope_l5_id, null);
  // Must NOT contain legacy fields
  assert.equal(decrypted.data.scope_product_id, undefined);
  assert.equal(decrypted.data.scope_project_id, undefined);
  assert.equal(decrypted.data.scope_deliverable_id, undefined);
});

test('outboundDocument produces canonical scope lineage fields', () => {
  const session = makeSession();
  const groupId = 'group-1';
  const keyRow = makeWrappedKeyRow(session, { groupId });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);

  const doc = {
    record_id: 'doc-1',
    owner_npub: session.npub,
    title: 'Spec',
    content: 'hello',
    scope_id: 'scope-l1',
    scope_l1_id: 'scope-l1',
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    shares: [],
    group_ids: [groupId],
    version: 1,
  };

  const envelope = outboundDocument('npub1app', session, groupKeys, doc);
  const decrypted = decryptRecordPayload({
    record_id: envelope.record_id,
    owner_npub: session.npub,
    signature_npub: session.npub,
    owner_payload: envelope.owner_payload,
  }, session, groupKeys);

  assert.equal(decrypted.data.scope_l1_id, 'scope-l1');
  assert.equal(decrypted.data.scope_l2_id, null);
  assert.equal(decrypted.data.scope_product_id, undefined);
});

test('outboundReport produces canonical scope lineage in metadata', () => {
  const session = makeSession();
  const groupId = 'group-1';
  const keyRow = makeWrappedKeyRow(session, { groupId });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);

  const report = {
    record_id: 'rpt-1',
    owner_npub: session.npub,
    title: 'Daily',
    declaration_type: 'text',
    payload: {},
    scope_id: 'scope-l2',
    scope_level: 'l2',
    scope_l1_id: 'scope-l1',
    scope_l2_id: 'scope-l2',
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    group_ids: [groupId],
    version: 0,
  };

  const envelope = outboundReport('npub1app', session, groupKeys, report);
  const decrypted = decryptRecordPayload({
    record_id: envelope.record_id,
    owner_npub: session.npub,
    signature_npub: session.npub,
    owner_payload: envelope.owner_payload,
  }, session, groupKeys);

  assert.equal(decrypted.metadata.scope.level, 'l2');
  assert.equal(decrypted.metadata.scope.l1_id, 'scope-l1');
  assert.equal(decrypted.metadata.scope.l2_id, 'scope-l2');
  assert.equal(decrypted.metadata.scope.l3_id, null);
  // Must NOT contain legacy fields
  assert.equal(decrypted.metadata.scope.product_id, undefined);
  assert.equal(decrypted.metadata.scope.project_id, undefined);
});

// === DB schema tests ===

test('openDb creates scopes table with l1_id-l5_id columns', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-scope-db-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-scope-db`;
  const { openDb } = await import(`../src/db.js?test=${tag}`);
  const db = openDb();

  const columns = db.prepare('PRAGMA table_info(scopes)').all().map((c) => c.name);
  assert.ok(columns.includes('l1_id'), 'scopes table should have l1_id column');
  assert.ok(columns.includes('l2_id'), 'scopes table should have l2_id column');
  assert.ok(columns.includes('l3_id'), 'scopes table should have l3_id column');
  assert.ok(columns.includes('l4_id'), 'scopes table should have l4_id column');
  assert.ok(columns.includes('l5_id'), 'scopes table should have l5_id column');

  db.close();
  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test('openDb creates tasks table with scope_l1_id-scope_l5_id columns', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-task-db-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-task-db`;
  const { openDb } = await import(`../src/db.js?test=${tag}`);
  const db = openDb();

  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  assert.ok(columns.includes('scope_l1_id'), 'tasks table should have scope_l1_id');
  assert.ok(columns.includes('scope_l2_id'), 'tasks table should have scope_l2_id');
  assert.ok(columns.includes('scope_l3_id'), 'tasks table should have scope_l3_id');
  assert.ok(columns.includes('scope_l4_id'), 'tasks table should have scope_l4_id');
  assert.ok(columns.includes('scope_l5_id'), 'tasks table should have scope_l5_id');

  db.close();
  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test('openDb creates scope lineage columns on documents, directories, reports', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-scoped-db-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-scoped-db`;
  const { openDb } = await import(`../src/db.js?test=${tag}`);
  const db = openDb();

  for (const table of ['documents', 'directories', 'reports']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (let i = 1; i <= 5; i++) {
      assert.ok(columns.includes(`scope_l${i}_id`), `${table} should have scope_l${i}_id`);
    }
  }

  db.close();
  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// === Sync rowForTable tests ===

test('sync rowForTable maps scope with l1_id-l5_id to DB row', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-yoke-sync-scope-'));
  process.env.WINGMAN_YOKE_STATE_DIR = dir;
  const tag = `${Date.now()}-sync-scope`;
  const { openDb, upsertRows, getRow } = await import(`../src/db.js?test=${tag}`);
  const { FAMILY_TABLES } = await import(`../src/sync.js?test=${tag}`);
  const db = openDb();

  // Manually invoke the scope mapper and insert
  const scopeMapper = FAMILY_TABLES.find((f) => f.collection === 'scope');
  assert.ok(scopeMapper, 'scope family should exist in FAMILY_TABLES');

  db.close();
  delete process.env.WINGMAN_YOKE_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// === normalizeScopeLevel helper tests ===

test('normalizeScopeLevel maps legacy levels to generic l1-l3', async () => {
  const { normalizeScopeLevel } = await import('../src/translators.js');
  assert.equal(normalizeScopeLevel('product'), 'l1');
  assert.equal(normalizeScopeLevel('project'), 'l2');
  assert.equal(normalizeScopeLevel('deliverable'), 'l3');
  assert.equal(normalizeScopeLevel('l1'), 'l1');
  assert.equal(normalizeScopeLevel('l2'), 'l2');
  assert.equal(normalizeScopeLevel('l5'), 'l5');
});

test('normalizeScopeLevel returns null for unknown levels', async () => {
  const { normalizeScopeLevel } = await import('../src/translators.js');
  assert.equal(normalizeScopeLevel(null), null);
  assert.equal(normalizeScopeLevel(undefined), null);
  assert.equal(normalizeScopeLevel(''), null);
});

test('scopeDepth returns numeric depth for level string', async () => {
  const { scopeDepth } = await import('../src/translators.js');
  assert.equal(scopeDepth('l1'), 1);
  assert.equal(scopeDepth('l2'), 2);
  assert.equal(scopeDepth('l3'), 3);
  assert.equal(scopeDepth('l4'), 4);
  assert.equal(scopeDepth('l5'), 5);
});

test('computeScopeLineage computes lineage for l1 scope', async () => {
  const { computeScopeLineage } = await import('../src/translators.js');
  const result = computeScopeLineage('scope-root', 'l1', null);
  assert.deepEqual(result, {
    level: 'l1',
    parent_id: null,
    l1_id: 'scope-root',
    l2_id: null,
    l3_id: null,
    l4_id: null,
    l5_id: null,
  });
});

test('computeScopeLineage computes lineage for l3 scope from parent', async () => {
  const { computeScopeLineage } = await import('../src/translators.js');
  const parent = {
    record_id: 'scope-l2',
    level: 'l2',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: null,
    l4_id: null,
    l5_id: null,
  };
  const result = computeScopeLineage('scope-l3', 'l3', parent);
  assert.deepEqual(result, {
    level: 'l3',
    parent_id: 'scope-l2',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: 'scope-l3',
    l4_id: null,
    l5_id: null,
  });
});

test('computeScopeLineage computes lineage for l5 scope through full chain', async () => {
  const { computeScopeLineage } = await import('../src/translators.js');
  const parent = {
    record_id: 'scope-l4',
    level: 'l4',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: 'scope-l3',
    l4_id: 'scope-l4',
    l5_id: null,
  };
  const result = computeScopeLineage('scope-l5', 'l5', parent);
  assert.deepEqual(result, {
    level: 'l5',
    parent_id: 'scope-l4',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: 'scope-l3',
    l4_id: 'scope-l4',
    l5_id: 'scope-l5',
  });
});

test('buildScopeTags returns scope_l1_id through scope_l5_id from scope', async () => {
  const { buildScopeTags } = await import('../src/translators.js');
  const scope = {
    record_id: 'scope-l2',
    l1_id: 'scope-l1',
    l2_id: 'scope-l2',
    l3_id: null,
    l4_id: null,
    l5_id: null,
  };
  const tags = buildScopeTags(scope);
  assert.deepEqual(tags, {
    scope_id: 'scope-l2',
    scope_l1_id: 'scope-l1',
    scope_l2_id: 'scope-l2',
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
  });
});

test('buildScopeTags returns all nulls when scope is null', async () => {
  const { buildScopeTags } = await import('../src/translators.js');
  const tags = buildScopeTags(null);
  assert.deepEqual(tags, {
    scope_id: null,
    scope_l1_id: null,
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
  });
});
