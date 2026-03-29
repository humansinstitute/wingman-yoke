import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { decodeNsec, encryptForNpub } from '../src/nostr.js';
import {
  decryptRecordPayload,
  inboundReport,
  inboundSchedule,
  inboundTask,
  loadGroupKeyMap,
  outboundDocument,
  outboundReport,
  outboundSchedule,
  outboundTask,
} from '../src/translators.js';

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

function makeWrappedKeyRow(session, {
  groupId,
  groupSecret = generateSecretKey(),
  keyVersion = 1,
}) {
  const groupNpub = makeNpub(groupSecret);
  return {
    group_id: groupId,
    group_npub: groupNpub,
    key_version: keyVersion,
    wrapped_group_nsec: encryptForNpub(session.secret, session.npub, nip19.nsecEncode(groupSecret)),
    wrapped_by_npub: session.npub,
  };
}

test('outboundDocument prefers person share via logical group for write_group_id', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const privateGroupId = 'group-private';
  const sharedGroupId = 'group-shared';
  const privateKeyRow = makeWrappedKeyRow(session, { groupId: privateGroupId, keyVersion: 1 });
  const sharedKeyRow = makeWrappedKeyRow(session, { groupId: sharedGroupId, keyVersion: 3 });
  const groupKeys = loadGroupKeyMap(session, [privateKeyRow, sharedKeyRow], decodeNsec);
  const document = {
    record_id: 'doc-1',
    owner_npub: ownerNpub,
    title: 'Doc',
    content: 'Body',
    shares: [
      {
        type: 'group',
        group_id: privateGroupId,
        group_npub: privateKeyRow.group_npub,
        access: 'write',
      },
      {
        type: 'person',
        person_npub: session.npub,
        via_group_id: sharedGroupId,
        via_group_npub: sharedKeyRow.group_npub,
        access: 'write',
      },
    ],
    group_ids: [privateGroupId, sharedGroupId],
    version: 3,
  };

  const envelope = outboundDocument('npub1app', session, groupKeys, document);

  assert.equal(envelope.write_group_id, sharedGroupId);
  assert.equal(envelope.write_group_npub, sharedKeyRow.group_npub);
  assert.deepEqual(
    envelope.group_payloads.map((payload) => ({
      group_id: payload.group_id,
      group_epoch: payload.group_epoch,
      group_npub: payload.group_npub,
    })),
    [
      { group_id: privateGroupId, group_epoch: 1, group_npub: privateKeyRow.group_npub },
      { group_id: sharedGroupId, group_epoch: 3, group_npub: sharedKeyRow.group_npub },
    ]
  );
});

test('outboundTask uses explicit board group id and emits epoch metadata', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const assigneeNpub = makeNpub();
  const groupAId = 'group-a';
  const groupBId = 'group-b';
  const groupAKeyRow = makeWrappedKeyRow(session, { groupId: groupAId, keyVersion: 1 });
  const groupBKeyRow = makeWrappedKeyRow(session, { groupId: groupBId, keyVersion: 2 });
  const groupKeys = loadGroupKeyMap(session, [groupAKeyRow, groupBKeyRow], decodeNsec);
  const task = {
    record_id: 'task-1',
    owner_npub: ownerNpub,
    title: 'Task',
    description: '',
    assigned_to_npub: assigneeNpub,
    shares: [],
    group_ids: [groupAId, groupBId],
    board_group_id: groupBId,
    version: 1,
  };

  const envelope = outboundTask('npub1app', session, groupKeys, task);
  const boardPayload = envelope.group_payloads.find((payload) => payload.group_id === groupBId);

  assert.equal(envelope.write_group_id, groupBId);
  assert.equal(envelope.write_group_npub, groupBKeyRow.group_npub);
  assert.equal(boardPayload?.group_epoch, 2);
  assert.equal(boardPayload?.group_npub, groupBKeyRow.group_npub);
  const groupPayload = decryptRecordPayload({
    record_id: 'task-1',
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: envelope.group_payloads,
  }, session, groupKeys);
  assert.equal(groupPayload.data.assigned_to_npub, assigneeNpub);
});

test('inboundTask reads assigned_to_npub from task payload', () => {
  const assigneeNpub = makeNpub();
  const task = inboundTask({
    record_id: 'task-2',
    owner_npub: makeNpub(),
    version: 2,
    group_payloads: [{
      group_id: 'group-a',
      group_npub: makeNpub(),
    }],
  }, {
    data: {
      title: 'Assigned task',
      assigned_to_npub: assigneeNpub,
    },
  });

  assert.equal(task.assigned_to_npub, assigneeNpub);
});

test('outboundTask preserves existing assignee when patch does not override it', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const assigneeNpub = makeNpub();
  const groupId = 'group-preserve';
  const keyRow = makeWrappedKeyRow(session, { groupId, keyVersion: 1 });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);
  const task = {
    record_id: 'task-keep-assignee',
    owner_npub: ownerNpub,
    title: 'Task',
    description: '',
    assigned_to_npub: assigneeNpub,
    shares: [],
    group_ids: [groupId],
    board_group_id: groupId,
    version: 4,
  };

  const envelope = outboundTask('npub1app', session, groupKeys, task, {
    title: 'Renamed task',
  });
  const decrypted = decryptRecordPayload({
    record_id: 'task-keep-assignee',
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: envelope.group_payloads,
  }, session, groupKeys);

  assert.equal(decrypted.data.title, 'Renamed task');
  assert.equal(decrypted.data.assigned_to_npub, assigneeNpub);
});

test('outboundTask falls back to an accessible shared group when the board group key is missing', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const privateGroupId = 'group-private-missing';
  const sharedGroupId = 'group-shared-accessible';
  const sharedKeyRow = makeWrappedKeyRow(session, { groupId: sharedGroupId, keyVersion: 4 });
  const groupKeys = loadGroupKeyMap(session, [sharedKeyRow], decodeNsec);
  const task = {
    record_id: 'task-fallback-group',
    owner_npub: ownerNpub,
    title: 'Task',
    description: '',
    shares: [
      { type: 'group', group_id: privateGroupId, access: 'write' },
      { type: 'group', group_id: sharedGroupId, access: 'write', group_npub: sharedKeyRow.group_npub },
    ],
    group_ids: [privateGroupId, sharedGroupId],
    board_group_id: privateGroupId,
    version: 2,
  };

  const envelope = outboundTask('npub1app', session, groupKeys, task, {
    description: 'Updated',
  });
  const decrypted = decryptRecordPayload({
    record_id: task.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: envelope.group_payloads,
  }, session, groupKeys);

  assert.equal(envelope.write_group_id, sharedGroupId);
  assert.equal(envelope.write_group_npub, sharedKeyRow.group_npub);
  assert.deepEqual(envelope.group_payloads.map((payload) => payload.group_id), [sharedGroupId]);
  assert.equal(decrypted.data.description, 'Updated');
});

test('decryptRecordPayload can still read epoch 1 records after later epochs are cached', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const groupId = 'group-1';
  const epoch1 = makeWrappedKeyRow(session, { groupId, keyVersion: 1 });
  const epoch2 = makeWrappedKeyRow(session, { groupId, keyVersion: 2 });
  const groupKeys = loadGroupKeyMap(session, [epoch1, epoch2], decodeNsec);
  const plaintext = JSON.stringify({
    data: {
      title: 'Old task',
    },
  });
  const record = {
    record_id: 'rec-1',
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: [{
      group_id: groupId,
      group_epoch: 1,
      group_npub: epoch1.group_npub,
      ciphertext: JSON.stringify({
        encrypted_by_npub: session.npub,
        ciphertext: encryptForNpub(session.secret, epoch1.group_npub, plaintext),
      }),
      write: true,
    }],
  };

  const decrypted = decryptRecordPayload(record, session, groupKeys);
  assert.deepEqual(decrypted, { data: { title: 'Old task' } });
});

test('inboundSchedule reads schedule payload fields', () => {
  const schedule = inboundSchedule({
    record_id: 'schedule-1',
    owner_npub: makeNpub(),
    version: 2,
    updated_at: '2026-03-16T12:00:00.000Z',
    group_payloads: [{
      group_id: 'group-schedule',
      group_npub: makeNpub(),
    }],
  }, {
    data: {
      title: 'Daily wrap-up',
      description: 'Post end-of-day summary',
      time_start: '21:30',
      time_end: '23:45',
      days: ['mon', 'tue'],
      timezone: 'Australia/Perth',
      assigned_group_id: 'group-schedule',
      active: true,
      last_run: '2026-03-16T13:30:00.000Z',
      repeat: 'daily',
    },
  });

  assert.equal(schedule.title, 'Daily wrap-up');
  assert.equal(schedule.time_start, '21:30');
  assert.equal(schedule.time_end, '23:45');
  assert.deepEqual(schedule.days, ['mon', 'tue']);
  assert.equal(schedule.timezone, 'Australia/Perth');
  assert.equal(schedule.assigned_group_id, 'group-schedule');
  assert.equal(schedule.active, true);
  assert.equal(schedule.repeat, 'daily');
  assert.deepEqual(schedule.group_ids, ['group-schedule']);
});

test('outboundSchedule emits a valid schedule record envelope', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const groupId = 'group-schedule';
  const keyRow = makeWrappedKeyRow(session, { groupId, keyVersion: 2 });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);
  const schedule = {
    record_id: 'schedule-2',
    owner_npub: ownerNpub,
    title: 'Morning briefing',
    description: 'Wake and briefing',
    time_start: '05:00',
    time_end: '07:00',
    days: ['mon', 'wed'],
    timezone: 'Australia/Perth',
    assigned_group_id: groupId,
    active: true,
    last_run: null,
    repeat: 'daily',
    shares: [],
    group_ids: [groupId],
    board_group_id: groupId,
    version: 1,
  };

  const envelope = outboundSchedule('npub1app', session, groupKeys, schedule);
  const decrypted = decryptRecordPayload({
    record_id: schedule.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: envelope.group_payloads,
  }, session, groupKeys);

  assert.equal(envelope.record_family_hash, 'npub1app:schedule');
  assert.equal(envelope.write_group_id, groupId);
  assert.equal(decrypted.data.collection_space, undefined);
  assert.equal(decrypted.collection_space, 'schedule');
  assert.equal(decrypted.data.assigned_group_id, groupId);
  assert.equal(decrypted.data.title, 'Morning briefing');
  assert.deepEqual(decrypted.data.days, ['mon', 'wed']);
});

test('inboundReport materializes declarative report metadata and payload', () => {
  const report = inboundReport({
    record_id: 'report-1',
    owner_npub: makeNpub(),
    version: 2,
    updated_at: '2026-03-25T01:00:00Z',
    group_payloads: [{
      group_id: 'group-report',
      group_npub: makeNpub(),
    }],
  }, {
    metadata: {
      title: 'Daily Users',
      generated_at: '2026-03-25T00:55:00Z',
      record_state: 'active',
      surface: 'flightdeck',
      scope: {
        id: 'scope-project',
        level: 'project',
        product_id: 'scope-product',
        project_id: 'scope-project',
        deliverable_id: null,
      },
    },
    data: {
      declaration_type: 'metric',
      payload: {
        label: 'Daily Users',
        value: 50,
      },
    },
  });

  assert.equal(report.title, 'Daily Users');
  assert.equal(report.declaration_type, 'metric');
  assert.equal(report.surface, 'flightdeck');
  assert.equal(report.scope_id, 'scope-project');
  assert.equal(report.scope_level, 'l2');
  assert.deepEqual(report.group_ids, ['group-report']);
  assert.equal(report.payload.value, 50);
});

test('outboundReport encrypts a report envelope compatible with Flight Deck schema', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const groupId = 'group-report';
  const keyRow = makeWrappedKeyRow(session, { groupId, keyVersion: 2 });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);

  const envelope = outboundReport('npub1app', session, groupKeys, {
    record_id: 'report-1',
    owner_npub: ownerNpub,
    title: 'Done Per Day',
    declaration_type: 'timeseries',
    payload: {
      x_label: 'Date',
      y_label: 'Done tasks',
      series: [{
        key: 'done',
        label: 'Done',
        points: [
          { x: '2026-03-20', y: 1 },
          { x: '2026-03-21', y: 2 },
        ],
      }],
    },
    surface: 'flightdeck',
    generated_at: '2026-03-25T00:55:00Z',
    scope_id: 'scope-project',
    scope_level: 'l2',
    scope_l1_id: 'scope-product',
    scope_l2_id: 'scope-project',
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    group_ids: [groupId],
    version: 0,
  });
  const decrypted = decryptRecordPayload({
    record_id: envelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: envelope.group_payloads,
  }, session, groupKeys);

  assert.equal(envelope.record_family_hash, 'npub1app:report');
  assert.equal(envelope.write_group_id, groupId);
  assert.equal(envelope.write_group_npub, keyRow.group_npub);
  assert.equal(decrypted.metadata.title, 'Done Per Day');
  assert.equal(decrypted.metadata.surface, 'flightdeck');
  assert.equal(decrypted.data.declaration_type, 'timeseries');
  assert.equal(decrypted.data.payload.series[0].points[1].y, 2);
});
