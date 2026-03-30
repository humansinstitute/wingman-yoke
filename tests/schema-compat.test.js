import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { decodeNsec, encryptForNpub } from '../src/nostr.js';
import { FAMILY_TABLES } from '../src/sync.js';
import {
  decryptRecordPayload,
  loadGroupKeyMap,
  outboundAudioNote,
  outboundChannel,
  outboundChatMessage,
  outboundComment,
  outboundDirectory,
  outboundDocument,
  outboundReport,
  outboundSchedule,
  outboundScope,
  outboundTask,
} from '../src/translators.js';
import { validateAgainstSchema } from '../../sb-publisher/src/schema-validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(__dirname, '../../sb-publisher/schemas/flightdeck');

function makeSession() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    secret,
    npub: nip19.npubEncode(pubkey),
  };
}

function makeWrappedKeyRow(session, {
  groupId,
  groupSecret = generateSecretKey(),
  keyVersion = 1,
}) {
  const groupNpub = nip19.npubEncode(getPublicKey(groupSecret));
  return {
    group_id: groupId,
    group_npub: groupNpub,
    key_version: keyVersion,
    wrapped_group_nsec: encryptForNpub(session.secret, session.npub, nip19.nsecEncode(groupSecret)),
    wrapped_by_npub: session.npub,
  };
}

function readManifest(family) {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, `${family}-v1.json`), 'utf8'));
}

function validatePayload(family, payload) {
  const manifest = readManifest(family);
  const result = validateAgainstSchema(manifest.payload_schema, payload);
  assert.equal(result.valid, true, `${family}: ${result.errors.join('; ')}`);
}

test('Yoke sync families cover published Flight Deck families except settings', () => {
  const syncedFamilies = FAMILY_TABLES.map((entry) => entry.collection).sort();
  assert.deepEqual(syncedFamilies, [
    'audio_note',
    'channel',
    'chat_message',
    'comment',
    'directory',
    'document',
    'report',
    'schedule',
    'scope',
    'task',
  ]);
});

test('Yoke outbound payloads remain compatible with published Flight Deck schemas', () => {
  const session = makeSession();
  const groupId = 'group-main';
  const keyRow = makeWrappedKeyRow(session, { groupId, keyVersion: 2 });
  const groupKeys = loadGroupKeyMap(session, [keyRow], decodeNsec);
  const ownerNpub = session.npub;

  const channelEnvelope = outboundChannel('npub1app', session, groupKeys, {
    recordId: 'channel-1',
    ownerNpub,
    title: 'Ops',
    groupIds: [groupId],
    participantNpubs: [ownerNpub],
    scopeId: 'project-1',
    scopeProductId: 'product-1',
    scopeProjectId: 'project-1',
  });
  const channel = decryptRecordPayload({
    record_id: channelEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    owner_payload: channelEnvelope.owner_payload,
  }, session, groupKeys);

  const taskEnvelope = outboundTask('npub1app', session, groupKeys, {
    record_id: 'task-1',
    owner_npub: ownerNpub,
    title: 'Build board',
    description: '',
    state: 'new',
    priority: 'rock',
    board_group_id: groupId,
    scope_id: 'deliverable-1',
    scope_product_id: 'product-1',
    scope_project_id: 'project-1',
    scope_deliverable_id: 'deliverable-1',
    shares: [],
    group_ids: [groupId],
    version: 1,
  });
  const task = decryptRecordPayload({
    record_id: taskEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: taskEnvelope.group_payloads,
  }, session, groupKeys);

  const documentEnvelope = outboundDocument('npub1app', session, groupKeys, {
    record_id: 'doc-1',
    owner_npub: ownerNpub,
    title: 'Spec',
    content: 'hello',
    parent_directory_id: 'dir-1',
    scope_id: 'deliverable-1',
    scope_product_id: 'product-1',
    scope_project_id: 'project-1',
    scope_deliverable_id: 'deliverable-1',
    shares: [],
    group_ids: [groupId],
    version: 1,
  });
  const document = decryptRecordPayload({
    record_id: documentEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: documentEnvelope.group_payloads,
  }, session, groupKeys);

  const directoryEnvelope = outboundDirectory('npub1app', session, groupKeys, {
    record_id: 'dir-1',
    owner_npub: ownerNpub,
    title: 'Projects',
    scope_id: 'product-1',
    scope_product_id: 'product-1',
    scope_project_id: null,
    scope_deliverable_id: null,
    shares: [],
    group_ids: [groupId],
    version: 1,
  });
  const directory = decryptRecordPayload({
    record_id: directoryEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: directoryEnvelope.group_payloads,
  }, session, groupKeys);

  const reportEnvelope = outboundReport('npub1app', session, groupKeys, {
    record_id: 'report-1',
    owner_npub: ownerNpub,
    title: 'Daily throughput',
    declaration_type: 'timeseries',
    payload: {
      x_label: 'Date',
      y_label: 'Done tasks',
      series: [
        {
          key: 'done',
          label: 'Done',
          points: [
            { x: '2026-03-20', y: 2 },
            { x: '2026-03-21', y: 3 },
          ],
        },
      ],
    },
    surface: 'flightdeck',
    generated_at: '2026-03-25T00:55:00Z',
    scope_id: 'project-1',
    scope_level: 'project',
    scope_product_id: 'product-1',
    scope_project_id: 'project-1',
    scope_deliverable_id: null,
    group_ids: [groupId],
    version: 0,
  });
  const report = decryptRecordPayload({
    record_id: reportEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: reportEnvelope.group_payloads,
  }, session, groupKeys);

  const commentEnvelope = outboundComment('npub1app', session, groupKeys, {
    record_id: 'task-1',
    owner_npub: ownerNpub,
    group_ids: [groupId],
  }, {
    recordId: 'comment-1',
    body: 'Looks good',
  });
  const comment = decryptRecordPayload({
    record_id: commentEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: commentEnvelope.group_payloads,
  }, session, groupKeys);

  const audioEnvelope = outboundAudioNote('npub1app', session, groupKeys, {
    recordId: 'audio-1',
    ownerNpub,
    targetRecordId: 'comment-1',
    targetRecordFamilyHash: 'npub1app:comment',
    storageObjectId: 'storage-1',
    targetGroupIds: [groupId],
  });
  const audio = decryptRecordPayload({
    record_id: audioEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: audioEnvelope.group_payloads,
  }, session, groupKeys);

  const scheduleEnvelope = outboundSchedule('npub1app', session, groupKeys, {
    record_id: 'schedule-1',
    owner_npub: ownerNpub,
    title: 'Daily',
    description: '',
    time_start: '09:00',
    time_end: '09:30',
    days: ['mon'],
    timezone: 'Australia/Perth',
    assigned_group_id: groupId,
    shares: [],
    group_ids: [groupId],
    version: 1,
  });
  const schedule = decryptRecordPayload({
    record_id: scheduleEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: scheduleEnvelope.group_payloads,
  }, session, groupKeys);

  const scopeEnvelope = outboundScope('npub1app', session, groupKeys, {
    record_id: 'scope-1',
    owner_npub: ownerNpub,
    title: 'Flight Deck',
    description: 'Product',
    level: 'product',
    shares: [],
    group_ids: [groupId],
    version: 1,
  });
  const scope = decryptRecordPayload({
    record_id: scopeEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: scopeEnvelope.group_payloads,
  }, session, groupKeys);

  const chatMessageEnvelope = outboundChatMessage('npub1app', session, groupKeys, {
    record_id: 'channel-1',
    owner_npub: ownerNpub,
    group_ids: [groupId],
  }, {
    recordId: 'msg-1',
    body: 'Hello',
  });
  const chatMessage = decryptRecordPayload({
    record_id: chatMessageEnvelope.record_id,
    owner_npub: ownerNpub,
    signature_npub: session.npub,
    group_payloads: chatMessageEnvelope.group_payloads,
  }, session, groupKeys);

  validatePayload('channel', channel);
  validatePayload('task', task);
  validatePayload('document', document);
  validatePayload('directory', directory);
  validatePayload('report', report);
  validatePayload('comment', comment);
  validatePayload('audio_note', audio);
  validatePayload('schedule', schedule);
  validatePayload('scope', scope);
  validatePayload('chat_message', chatMessage);
});
