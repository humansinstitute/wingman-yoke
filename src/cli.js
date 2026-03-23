#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initConfigFromToken, loadConfig } from './config.js';
import { getMeta, getRow, getRows, openDb } from './db.js';
import { resolveStorageLinks } from './render.js';
import { SuperbasedClient } from './client.js';
import { buildWrappedMemberKeys, createGroupIdentity, decodeNsec, getSession } from './nostr.js';
import { createStorageMarkdown, defaultFileName, detectMimeType, uploadEncryptedAudioToStorage, uploadFileToStorage } from './storage.js';
import { syncWorkspace } from './sync.js';
import { loadGroupKeyMap, makeGroupWriteShare, outboundAudioNote, outboundChannel, outboundChatMessage, outboundComment, outboundDirectory, outboundDocument, outboundSchedule, outboundScope, outboundTask, recordFamilyHash } from './translators.js';

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error('No config found. Run `wingman-yoke init --token <token>` first.');
  return config;
}

function getDbRows(tableSql, params = []) {
  const db = openDb();
  return getRows(db, tableSql, params);
}

function getDbRow(tableSql, params = []) {
  const db = openDb();
  return getRow(db, tableSql, params);
}

function printResult(output) {
  if (program.opts().json) console.log(JSON.stringify(output, null, 2));
  else console.log(output);
}

function jsonField(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getClientAndState() {
  const config = requireConfig();
  const session = getSession();
  const db = openDb();
  const keyRows = getRows(db, `SELECT * FROM group_keys_cache ORDER BY group_id, key_version`);
  const groupKeys = loadGroupKeyMap(session, keyRows, decodeNsec);
  const client = new SuperbasedClient({ config, session, groupKeys });
  return { config, session, db, client, groupKeys };
}

async function refreshClientAndState() {
  let state = getClientAndState();
  await syncWorkspace({ client: state.client, config: state.config, session: state.session, quiet: true });
  state = getClientAndState();
  return state;
}

function parseRawRow(row) {
  return row?.raw_json ? JSON.parse(row.raw_json) : null;
}

function getPrimaryGroup(db) {
  return getRow(db, `SELECT * FROM groups_cache ORDER BY name ASC, group_id ASC LIMIT 1`);
}

function requirePrimaryGroup(db) {
  const row = getPrimaryGroup(db);
  if (!row) throw new Error('No accessible groups found. Run sync first or share a group to this agent.');
  return row;
}

function findGroupByRef(db, groupRef) {
  return getRow(db, `SELECT * FROM groups_cache WHERE group_id = ? OR current_group_npub = ?`, [groupRef, groupRef]);
}

function resolveStorageAccessGroupIds(db, groupRefs = []) {
  return [...new Set((groupRefs || []).map((groupRef) => {
    const ref = String(groupRef || '').trim();
    if (!ref) return null;
    const row = findGroupByRef(db, ref);
    if (row?.group_id) return row.group_id;
    return null;
  }).filter(Boolean))];
}

function buildDefaultGroupShares(group, label = '') {
  return [makeGroupWriteShare(group, label)];
}

function findCommentRow(db, commentId) {
  return getRow(db, `SELECT * FROM comments WHERE record_id = ?`, [commentId]);
}

function findDirectoryRow(db, directoryId) {
  return getRow(db, `SELECT * FROM directories WHERE record_id = ?`, [directoryId]);
}

function findScopeRow(db, scopeId) {
  return getRow(db, `SELECT * FROM scopes WHERE record_id = ?`, [scopeId]);
}

function maybeParseInt(value) {
  if (value == null || value === '') return null;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function resolveAssigneeValue(options, currentValue = null) {
  if (options.clearAssignee) return null;
  if (options.assign !== undefined) {
    const nextValue = String(options.assign || '').trim();
    return nextValue || null;
  }
  return currentValue;
}

function resolveScopeLinkPatch(db, scopeRef, options = {}) {
  if (options.clearScope) {
    return {
      scope_id: null,
      scope_product_id: null,
      scope_project_id: null,
      scope_deliverable_id: null,
    };
  }
  const ref = String(scopeRef || '').trim();
  if (!ref) return {};
  const row = findScopeRow(db, ref);
  if (!row) throw new Error(`Scope not found: ${scopeRef}`);
  const scope = parseRawRow(row) || row;
  if (scope.level === 'product') {
    return {
      scope_id: scope.record_id,
      scope_product_id: scope.record_id,
      scope_project_id: null,
      scope_deliverable_id: null,
    };
  }
  if (scope.level === 'project') {
    return {
      scope_id: scope.record_id,
      scope_product_id: scope.product_id ?? scope.parent_id ?? null,
      scope_project_id: scope.record_id,
      scope_deliverable_id: null,
    };
  }
  return {
    scope_id: scope.record_id,
    scope_product_id: scope.product_id ?? null,
    scope_project_id: scope.project_id ?? scope.parent_id ?? null,
    scope_deliverable_id: scope.record_id,
  };
}

function resolveRecordSharesAndGroups({ db, explicitGroupRef = null, inherited = null }) {
  if (explicitGroupRef) {
    const group = findGroupByRef(db, explicitGroupRef);
    if (!group) throw new Error(`Group not found: ${explicitGroupRef}`);
    return {
      groupIds: [group.group_id],
      shares: buildDefaultGroupShares(group, group.name || ''),
    };
  }

  if (inherited) {
    const inheritedGroupIds = inherited.group_ids ?? jsonField(inherited.group_ids_json);
    const inheritedShares = inherited.shares ?? jsonField(inherited.shares_json);
    return {
      groupIds: inheritedGroupIds || [],
      shares: inheritedShares || [],
    };
  }

  const primaryGroup = requirePrimaryGroup(db);
  return {
    groupIds: [primaryGroup.group_id],
    shares: buildDefaultGroupShares(primaryGroup, primaryGroup.name || ''),
  };
}

function normalizeScopeLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  if (!['product', 'project', 'deliverable'].includes(value)) {
    throw new Error('Scope level must be one of: product, project, deliverable.');
  }
  return value;
}

function resolveScopedHierarchy(db, { level, parentId = null, productId = null, projectId = null }) {
  const next = {
    level: normalizeScopeLevel(level),
    parent_id: parentId || null,
    product_id: productId || null,
    project_id: projectId || null,
  };

  const parentRow = next.parent_id ? findScopeRow(db, next.parent_id) : null;
  const parent = parentRow ? (parseRawRow(parentRow) || parentRow) : null;
  if (next.parent_id && !parent) throw new Error(`Parent scope not found: ${next.parent_id}`);

  if (next.level === 'product') {
    return {
      level: next.level,
      parent_id: null,
      product_id: null,
      project_id: null,
    };
  }

  if (next.level === 'project') {
    return {
      level: next.level,
      parent_id: parent?.record_id ?? next.parent_id,
      product_id: next.product_id ?? (parent?.level === 'product' ? parent.record_id : parent?.product_id ?? null),
      project_id: null,
    };
  }

  return {
    level: next.level,
    parent_id: parent?.record_id ?? next.parent_id,
    product_id: next.product_id ?? (parent?.level === 'product' ? parent.record_id : parent?.product_id ?? null),
    project_id: next.project_id ?? (parent?.level === 'project' ? parent.record_id : parent?.project_id ?? null),
  };
}

function normalizeNpubList(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => String(value || '').trim()).filter(Boolean))];
}

function resolveRotatedMemberNpubs(group, options, session) {
  const currentMembers = normalizeNpubList(group.member_npubs ?? jsonField(group.member_npubs_json));
  const additions = normalizeNpubList(options.addMember);
  const removals = new Set(normalizeNpubList(options.removeMember));
  const nextMembers = new Set([...currentMembers, ...additions]);

  for (const memberNpub of removals) {
    nextMembers.delete(memberNpub);
  }

  if (group.owner_npub) nextMembers.add(group.owner_npub);
  if (session.npub) nextMembers.add(session.npub);

  const resolved = [...nextMembers];
  if (resolved.length === 0) {
    throw new Error('Group rotation requires at least one member.');
  }
  return resolved;
}

async function createAudioAttachmentBatch({
  db,
  config,
  session,
  client,
  groupKeys,
  filePath,
  title,
  targetRecordId,
  targetRecordFamilyHash,
  targetGroupIds,
  writeGroupId,
}) {
  const uploaded = await uploadEncryptedAudioToStorage(client, filePath, {
    ownerNpub: config.workspaceOwnerNpub,
    accessGroupIds: resolveStorageAccessGroupIds(db, targetGroupIds),
    contentType: detectMimeType(filePath, 'audio/webm'),
    fileName: defaultFileName(filePath, 'voice-note'),
  });
  const audioRecordId = crypto.randomUUID();
  const audioEnvelope = outboundAudioNote(config.appNpub, session, groupKeys, {
    recordId: audioRecordId,
    ownerNpub: config.workspaceOwnerNpub,
    targetRecordId,
    targetRecordFamilyHash,
    title,
    storageObjectId: uploaded.object_id,
    mimeType: uploaded.content_type,
    durationSeconds: null,
    sizeBytes: uploaded.size_bytes,
    mediaEncryption: uploaded.media_encryption,
    transcriptStatus: 'pending',
    targetGroupIds,
    writeGroupNpub: writeGroupId,
  });
  const attachment = {
    kind: 'audio',
    audio_note_record_id: audioRecordId,
    title,
    duration_seconds: null,
  };
  return { audioEnvelope, attachment, audioRecordId };
}

async function syncRecordsAndRefresh(client, config, session, envelopes) {
  const result = await client.syncRecords(envelopes);
  await syncWorkspace({ client, config, session, quiet: true });
  return result;
}

async function withResolvedLinks(client, row, bodyField) {
  if (!row) return null;
  return {
    ...row,
    resolved_storage_links: await resolveStorageLinks(client, row[bodyField] || ''),
  };
}

function audioTranscriptPreview(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 21).join(' ') + (words.length > 21 ? '...' : '');
}

function audioTranscriptSummary(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const sentences = source.match(/[^.!?]+[.!?]?/g) || [source];
  return sentences.slice(0, 2).join(' ').trim();
}

function audioSourceExtension(mimeType) {
  if (String(mimeType || '').includes('ogg')) return 'ogg';
  if (String(mimeType || '').includes('wav')) return 'wav';
  if (String(mimeType || '').includes('mp4')) return 'm4a';
  return 'webm';
}

function sanitizeStorageFileName(name, extension = 'bin') {
  const base = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${base || 'voice-note'}.${extension}`;
}

function candidateStorageDates(note) {
  const dates = new Set();
  const updatedAt = String(note?.updated_at || '').slice(0, 10);
  if (updatedAt) dates.add(updatedAt);

  const title = String(note?.title || '');
  const match = title.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (match) {
    const months = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };
    const month = months[match[2]];
    if (month) {
      const day = String(match[1]).padStart(2, '0');
      dates.add(`${match[3]}-${month}-${day}`);
    }
  }

  return [...dates].filter(Boolean);
}

async function fallbackDownloadAudioNoteBuffer(note) {
  if (!/^(1|true|yes)$/i.test(String(process.env.WINGMAN_YOKE_ALLOW_STORAGE_KEY_GUESS || ''))) {
    return null;
  }
  const endpoint = process.env.STORAGE_S3_ENDPOINT_PUBLIC || 'https://storage.otherstuff.studio';
  const bucket = process.env.STORAGE_S3_BUCKET || 'superbased-storage';
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY || 'superbased';
  const secretAccessKey = process.env.STORAGE_S3_SECRET_KEY || 'superbased-secret';
  const candidateDates = candidateStorageDates(note);
  if (!note?.storage_object_id || !note?.owner_npub || candidateDates.length === 0) return null;

  const ext = audioSourceExtension(note.mime_type);
  const fileCandidates = [
    sanitizeStorageFileName(note.title, ext),
    `voice-note.${ext}`,
    `${note.record_id}.${ext}`,
    `${note.storage_object_id}.${ext}`,
  ];
  const keyCandidates = candidateDates.flatMap((objectDate) =>
    fileCandidates.map((fileName) => `v4/${note.owner_npub}/${objectDate}/${note.storage_object_id}-${fileName}`)
  );
  const helperInput = JSON.stringify({
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.STORAGE_S3_REGION || 'us-east-1',
    endpoint,
    virtualHostedStyle: !/^(true|1|yes)$/i.test(String(process.env.STORAGE_S3_FORCE_PATH_STYLE || 'true')),
    keys: keyCandidates,
  });

  const helperScript = `
    const input = JSON.parse(process.env.WINGMAN_YOKE_AUDIO_S3_INPUT || '{}');
    const client = new Bun.S3Client({
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      virtualHostedStyle: Boolean(input.virtualHostedStyle),
    });
    let payload = null;
    for (const key of input.keys || []) {
      try {
        const url = client.presign(key, { expiresIn: 120 });
        const response = await fetch(url);
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer()).toString('base64');
        payload = { key, bytes };
        break;
      } catch {}
    }
    if (payload) console.log(JSON.stringify(payload));
  `;

  try {
    const raw = execFileSync('bun', ['-e', helperScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WINGMAN_YOKE_AUDIO_S3_INPUT: helperInput,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return payload?.bytes ? Buffer.from(payload.bytes, 'base64') : null;
  } catch {
    return null;
  }
}

async function downloadAndDecryptAudioNote(client, note) {
  if (!note?.storage_object_id) throw new Error('Audio note has no storage object.');
  if (!note?.media_encryption?.key_b64 || !note?.media_encryption?.iv_b64) {
    throw new Error('Audio note is missing media_encryption metadata.');
  }

  await client.getStorageObject(note.storage_object_id);

  let cipherBuffer = null;
  try {
    cipherBuffer = Buffer.from(await client.getStorageContent(note.storage_object_id));
  } catch (error) {
    const fallback = await fallbackDownloadAudioNoteBuffer(note);
    if (!fallback) throw error;
    cipherBuffer = fallback;
  }

  const key = Buffer.from(note.media_encryption.key_b64, 'base64');
  const iv = Buffer.from(note.media_encryption.iv_b64, 'base64');
  const authTag = cipherBuffer.slice(cipherBuffer.length - 16);
  const encrypted = cipherBuffer.slice(0, cipherBuffer.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function transcribeAudioBuffer(audioBuffer, audioNoteId, mimeType = 'audio/webm;codecs=opus', modelPath) {
  const ffmpegPath = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
  const whisperCliPath = process.env.WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
  const sourceExt = String(mimeType || '').includes('ogg') ? 'ogg' : 'webm';
  const tempDir = mkdtempSync(join(tmpdir(), 'wingman-yoke-audio-'));
  const sourcePath = join(tempDir, `${audioNoteId}.${sourceExt}`);
  const wavPath = join(tempDir, `${audioNoteId}.wav`);

  try {
    writeFileSync(sourcePath, audioBuffer);
    execFileSync(ffmpegPath, ['-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return execFileSync(whisperCliPath, ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-l', 'auto'], {
      encoding: 'utf8',
      timeout: 300000,
    }).trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const program = new Command();
program
  .name('wingman-yoke')
  .description('Wingman-Yoke CLI for Coworker v4 / SuperBased')
  .option('--json', 'print machine-readable JSON');

program
  .command('init')
  .requiredOption('--token <token>', 'SuperBased connection token')
  .action((options) => {
    const config = initConfigFromToken(options.token);
    console.log(`Saved config for ${config.workspaceOwnerNpub} at ${config.directHttpsUrl}`);
  });

program
  .command('status')
  .action(() => {
    const config = requireConfig();
    const db = openDb();
    const counts = {
      channels: getRow(db, `SELECT COUNT(*) AS count FROM channels`)?.count ?? 0,
      messages: getRow(db, `SELECT COUNT(*) AS count FROM messages`)?.count ?? 0,
      tasks: getRow(db, `SELECT COUNT(*) AS count FROM tasks`)?.count ?? 0,
      comments: getRow(db, `SELECT COUNT(*) AS count FROM comments`)?.count ?? 0,
      documents: getRow(db, `SELECT COUNT(*) AS count FROM documents`)?.count ?? 0,
      schedules: getRow(db, `SELECT COUNT(*) AS count FROM schedules`)?.count ?? 0,
    };
    const output = {
      config: {
        directHttpsUrl: config.directHttpsUrl,
        workspaceOwnerNpub: config.workspaceOwnerNpub,
        appNpub: config.appNpub,
        serviceNpub: config.serviceNpub,
      },
      lastSyncAt: getMeta(db, 'sync:last_at'),
      counts,
    };
    if (program.opts().json) console.log(JSON.stringify(output, null, 2));
    else console.log(output);
  });

async function runSyncCommand() {
  const { config, session, client } = getClientAndState();
  const counts = await syncWorkspace({ client, config, session });
  if (program.opts().json) console.log(JSON.stringify({ synced: counts }, null, 2));
  else console.log(counts);
}

program.command('sync').action(runSyncCommand);
program.command('getLatest').action(runSyncCommand);

const groups = program.command('groups');
groups.command('rotate')
  .argument('<groupRef>')
  .option('--add-member <npub...>', 'include additional members in the rotated epoch')
  .option('--remove-member <npub...>', 'exclude members from the rotated epoch')
  .option('--name <name>', 'optionally rename the group while rotating')
  .action(async (groupRef, options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const row = findGroupByRef(db, groupRef);
    if (!row) throw new Error(`Group not found: ${groupRef}`);
    const group = parseRawRow(row) || row;
    const memberNpubs = resolveRotatedMemberNpubs(group, options, session);
    const groupIdentity = createGroupIdentity();
    const response = await client.rotateGroup(group.group_id, {
      group_npub: groupIdentity.npub,
      member_keys: buildWrappedMemberKeys(groupIdentity, memberNpubs, session.npub, session.secret),
      ...(options.name !== undefined ? { name: options.name } : {}),
    });
    await syncWorkspace({ client, config, session, quiet: true });
    printResult({
      ...response,
      member_npubs: memberNpubs,
    });
  });

const tasks = program.command('tasks');
tasks.command('create')
  .requiredOption('--title <title>')
  .option('--description <description>')
  .option('--state <state>', 'task state', 'new')
  .option('--priority <priority>', 'task priority', 'sand')
  .option('--assign <npub>', 'set assigned_to_npub')
  .option('--tags <tags>')
  .option('--scheduled-for <date>')
  .option('--parent <taskId>')
  .option('--group <groupRef>')
  .option('--scope <scopeId>')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const primaryGroup = options.group
      ? findGroupByRef(db, options.group)
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const recordId = crypto.randomUUID();
    const groupId = primaryGroup.group_id;
    const shares = buildDefaultGroupShares(primaryGroup, primaryGroup.name || '');
    const scopePatch = resolveScopeLinkPatch(db, options.scope);
    const envelope = outboundTask(config.appNpub, session, groupKeys, {
      record_id: recordId,
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      description: options.description ?? '',
      state: options.state ?? 'new',
      priority: options.priority ?? 'sand',
      assigned_to_npub: resolveAssigneeValue(options, null),
      parent_task_id: options.parent ?? null,
      board_group_id: groupId,
      scheduled_for: options.scheduledFor ?? null,
      tags: options.tags ?? '',
      ...scopePatch,
      shares,
      group_ids: [groupId],
      version: 0,
      signature_npub: session.npub,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

tasks.command('list')
  .option('--state <state>')
  .action((options) => {
    const db = openDb();
    const rows = options.state
      ? getRows(db, `SELECT * FROM tasks WHERE state = ? AND record_state != 'deleted' ORDER BY updated_at DESC`, [options.state])
      : getRows(db, `SELECT * FROM tasks WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    const output = rows.map((row) => ({
      record_id: row.record_id,
      title: row.title,
      state: row.state,
      priority: row.priority,
      assigned_to_npub: row.assigned_to_npub ?? null,
      scheduled_for: row.scheduled_for,
      group_ids: jsonField(row.group_ids_json),
      updated_at: row.updated_at,
    }));
    if (program.opts().json) console.log(JSON.stringify(output, null, 2));
    else output.forEach((row) => console.log(`${row.record_id} | ${row.state} | ${row.title} | ${row.assigned_to_npub || 'unassigned'}`));
  });

tasks.command('show')
  .argument('<taskId>')
  .action(async (taskId) => {
    const { client, db } = getClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const enriched = await withResolvedLinks(client, row, 'description');
    if (program.opts().json) console.log(JSON.stringify(enriched, null, 2));
    else console.log(enriched);
  });

tasks.command('update')
  .argument('<taskId>')
  .option('--title <title>')
  .option('--description <description>')
  .option('--state <state>')
  .option('--priority <priority>')
  .option('--assign <npub>', 'set assigned_to_npub')
  .option('--clear-assignee', 'clear assigned_to_npub')
  .option('--tags <tags>')
  .option('--scheduled-for <date>')
  .option('--scope <scopeId>')
  .option('--clear-scope')
  .action(async (taskId, options) => {
    let { client, db, config, session, groupKeys } = getClientAndState();
    await syncWorkspace({ client, config, session, quiet: true });
    ({ client, db, config, session, groupKeys } = getClientAndState());
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = JSON.parse(row.raw_json);
    const envelope = outboundTask(config.appNpub, session, groupKeys, task, {
      title: options.title ?? task.title,
      description: options.description ?? task.description,
      state: options.state ?? task.state,
      priority: options.priority ?? task.priority,
      assigned_to_npub: resolveAssigneeValue(options, task.assigned_to_npub ?? null),
      tags: options.tags ?? task.tags,
      scheduled_for: options.scheduledFor ?? task.scheduled_for,
      ...resolveScopeLinkPatch(db, options.scope, options),
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

tasks.command('comment')
  .argument('<taskId>')
  .requiredOption('--body <body>')
  .option('--parent <commentId>', 'parent comment id for thread reply')
  .action(async (taskId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const envelope = outboundComment(config.appNpub, session, groupKeys, task, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentCommentId: options.parent ?? null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

tasks.command('reply')
  .argument('<commentId>')
  .requiredOption('--body <body>')
  .action(async (commentId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const parentComment = findCommentRow(db, commentId);
    if (!parentComment) throw new Error(`Comment not found: ${commentId}`);
    const taskRow = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [parentComment.target_record_id]);
    if (!taskRow) throw new Error(`Target task not found: ${parentComment.target_record_id}`);
    const task = parseRawRow(taskRow);
    const envelope = outboundComment(config.appNpub, session, groupKeys, task, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentCommentId: commentId,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

tasks.command('voice')
  .argument('<taskId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text comment body', '')
  .option('--title <title>', 'audio note title')
  .option('--parent <commentId>', 'parent comment id for thread reply')
  .action(async (taskId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const commentId = crypto.randomUUID();
    const title = options.title || `Task Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      db,
      config,
      session,
      client,
      groupKeys,
      filePath: options.file,
      title,
      targetRecordId: commentId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'comment'),
      targetGroupIds: task.group_ids || [],
      writeGroupId: task.board_group_id || task.group_ids?.[0] || null,
    });
    const commentEnvelope = outboundComment(config.appNpub, session, groupKeys, task, {
      recordId: commentId,
      body: options.body || '',
      parentCommentId: options.parent ?? null,
      attachments: [attachment],
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [audioEnvelope, commentEnvelope]));
  });

tasks.command('comment-image')
  .argument('<taskId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text before image', '')
  .option('--parent <commentId>', 'parent comment id for thread reply')
  .action(async (taskId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupIds: resolveStorageAccessGroupIds(db, task.group_ids || []),
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'task-comment-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundComment(config.appNpub, session, groupKeys, task, {
      recordId: crypto.randomUUID(),
      body,
      parentCommentId: options.parent ?? null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

const chat = program.command('chat');
chat.command('create')
  .requiredOption('--title <title>')
  .option('--group <groupRef>')
  .option('--participant <npub...>', 'participant npubs')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const primaryGroup = options.group
      ? findGroupByRef(db, options.group)
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const groupId = primaryGroup.group_id;
    const participantNpubs = [...new Set([session.npub, ...(options.participant || [])].filter(Boolean))];
    const envelope = outboundChannel(config.appNpub, session, groupKeys, {
      recordId: crypto.randomUUID(),
      ownerNpub: config.workspaceOwnerNpub,
      title: options.title,
      groupIds: [groupId],
      participantNpubs,
      version: 1,
      previousVersion: 0,
      writeGroupNpub: groupId,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

chat.command('channels')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM channels WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    if (program.opts().json) console.log(JSON.stringify(rows, null, 2));
    else rows.forEach((row) => console.log(`${row.record_id} | ${row.title}`));
  });

chat.command('messages')
  .argument('<channelId>')
  .option('--thread <messageId>')
  .action(async (channelId, options) => {
    const { client, db } = getClientAndState();
    const rows = options.thread
      ? getRows(db, `SELECT * FROM messages WHERE channel_id = ? AND (record_id = ? OR parent_message_id = ?) ORDER BY updated_at ASC`, [channelId, options.thread, options.thread])
      : getRows(db, `SELECT * FROM messages WHERE channel_id = ? AND parent_message_id IS NULL ORDER BY updated_at ASC`, [channelId]);
    const enriched = [];
    for (const row of rows) enriched.push(await withResolvedLinks(client, row, 'body'));
    if (program.opts().json) console.log(JSON.stringify(enriched, null, 2));
    else enriched.forEach((row) => console.log(`${row.record_id} | ${row.sender_npub} | ${row.body}`));
  });

chat.command('send')
  .argument('<channelId>')
  .requiredOption('--body <body>')
  .option('--thread <messageId>')
  .action(async (channelId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const envelope = outboundChatMessage(config.appNpub, session, groupKeys, channel, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentMessageId: options.thread ?? null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

chat.command('reply')
  .argument('<channelId>')
  .requiredOption('--thread <messageId>')
  .requiredOption('--body <body>')
  .action(async (channelId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const envelope = outboundChatMessage(config.appNpub, session, groupKeys, channel, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentMessageId: options.thread,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

chat.command('image')
  .argument('<channelId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text before image', '')
  .option('--thread <messageId>')
  .action(async (channelId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupIds: resolveStorageAccessGroupIds(db, channel.group_ids || []),
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'chat-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundChatMessage(config.appNpub, session, groupKeys, channel, {
      recordId: crypto.randomUUID(),
      body,
      parentMessageId: options.thread ?? null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

chat.command('voice')
  .argument('<channelId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text message body', '')
  .option('--thread <messageId>')
  .option('--title <title>')
  .action(async (channelId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const messageId = crypto.randomUUID();
    const title = options.title || `Chat Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      db,
      config,
      session,
      client,
      groupKeys,
      filePath: options.file,
      title,
      targetRecordId: messageId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'chat_message'),
      targetGroupIds: channel.group_ids || [],
      writeGroupId: channel.group_ids?.[0] || null,
    });
    const messageEnvelope = outboundChatMessage(config.appNpub, session, groupKeys, channel, {
      recordId: messageId,
      body: options.body || '',
      parentMessageId: options.thread ?? null,
      attachments: [attachment],
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [audioEnvelope, messageEnvelope]));
  });

const directories = program.command('directories');
directories.command('create')
  .requiredOption('--title <title>')
  .option('--parent-directory <directoryId>')
  .option('--group <groupRef>')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const parentRow = options.parentDirectory ? findDirectoryRow(db, options.parentDirectory) : null;
    if (options.parentDirectory && !parentRow) throw new Error(`Directory not found: ${options.parentDirectory}`);
    const { groupIds, shares } = resolveRecordSharesAndGroups({
      db,
      explicitGroupRef: options.group ?? null,
      inherited: parentRow ? (parseRawRow(parentRow) || parentRow) : null,
    });
    const envelope = outboundDirectory(config.appNpub, session, groupKeys, {
      record_id: crypto.randomUUID(),
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      parent_directory_id: options.parentDirectory ?? null,
      shares,
      group_ids: groupIds,
      version: 0,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

directories.command('list')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM directories WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    const output = rows.map((row) => ({
      record_id: row.record_id,
      title: row.title,
      parent_directory_id: row.parent_directory_id,
      group_ids: jsonField(row.group_ids_json),
      updated_at: row.updated_at,
    }));
    printResult(output);
  });

directories.command('show')
  .argument('<directoryId>')
  .action((directoryId) => {
    const db = openDb();
    const row = findDirectoryRow(db, directoryId);
    if (!row) throw new Error(`Directory not found: ${directoryId}`);
    printResult(parseRawRow(row) || row);
  });

directories.command('update')
  .argument('<directoryId>')
  .option('--title <title>')
  .option('--parent-directory <directoryId>')
  .option('--clear-parent')
  .option('--group <groupRef>')
  .action(async (directoryId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = findDirectoryRow(db, directoryId);
    if (!row) throw new Error(`Directory not found: ${directoryId}`);
    const directory = parseRawRow(row) || row;
    const patch = {};
    if (options.title !== undefined) patch.title = options.title;
    if (options.parentDirectory !== undefined) patch.parent_directory_id = options.parentDirectory;
    if (options.clearParent) patch.parent_directory_id = null;
    if (options.group !== undefined) {
      const { groupIds, shares } = resolveRecordSharesAndGroups({ db, explicitGroupRef: options.group });
      patch.group_ids = groupIds;
      patch.shares = shares;
    }
    const envelope = outboundDirectory(config.appNpub, session, groupKeys, directory, patch);
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

const docs = program.command('docs');
docs.command('create')
  .requiredOption('--title <title>')
  .option('--content <content>', '', '')
  .option('--content-file <path>')
  .option('--group <groupRef>')
  .option('--parent-directory <directoryId>')
  .option('--scope <scopeId>')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const primaryGroup = options.group
      ? findGroupByRef(db, options.group)
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const groupId = primaryGroup.group_id;
    const shares = buildDefaultGroupShares(primaryGroup, primaryGroup.name || '');
    const content = options.contentFile ? readFileSync(options.contentFile, 'utf8') : options.content;
    const scopePatch = resolveScopeLinkPatch(db, options.scope);
    const envelope = outboundDocument(config.appNpub, session, groupKeys, {
      record_id: crypto.randomUUID(),
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      content: content ?? '',
      parent_directory_id: options.parentDirectory ?? null,
      ...scopePatch,
      shares,
      group_ids: [groupId],
      version: 0,
      signature_npub: session.npub,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

docs.command('list')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM documents WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    if (program.opts().json) console.log(JSON.stringify(rows, null, 2));
    else rows.forEach((row) => console.log(`${row.record_id} | ${row.title}`));
  });

docs.command('show')
  .argument('<docId>')
  .action(async (docId) => {
    const { client, db } = getClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const enriched = await withResolvedLinks(client, row, 'content');
    if (program.opts().json) console.log(JSON.stringify(enriched, null, 2));
    else console.log(enriched);
  });

docs.command('comment')
  .argument('<docId>')
  .requiredOption('--body <body>')
  .option('--parent <commentId>', 'parent comment id for thread reply')
  .option('--line <line>', 'anchor line number', Number.parseInt)
  .action(async (docId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const envelope = outboundComment(config.appNpub, session, groupKeys, doc, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentCommentId: options.parent ?? null,
      anchorLineNumber: Number.isFinite(options.line) ? options.line : 1,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

docs.command('reply')
  .argument('<commentId>')
  .requiredOption('--body <body>')
  .action(async (commentId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const parentComment = findCommentRow(db, commentId);
    if (!parentComment) throw new Error(`Comment not found: ${commentId}`);
    const docRow = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [parentComment.target_record_id]);
    if (!docRow) throw new Error(`Target document not found: ${parentComment.target_record_id}`);
    const doc = parseRawRow(docRow);
    const envelope = outboundComment(config.appNpub, session, groupKeys, doc, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentCommentId: commentId,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

docs.command('comment-image')
  .argument('<docId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text before image', '')
  .option('--parent <commentId>')
  .option('--line <line>', 'anchor line number', Number.parseInt)
  .action(async (docId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupIds: resolveStorageAccessGroupIds(db, doc.group_ids || []),
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'doc-comment-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundComment(config.appNpub, session, groupKeys, doc, {
      recordId: crypto.randomUUID(),
      body,
      parentCommentId: options.parent ?? null,
      anchorLineNumber: Number.isFinite(options.line) ? options.line : null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

docs.command('voice')
  .argument('<docId>')
  .requiredOption('--file <path>')
  .option('--body <body>', 'optional text comment body', '')
  .option('--title <title>')
  .option('--parent <commentId>')
  .option('--line <line>', 'anchor line number', Number.parseInt)
  .action(async (docId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const commentId = crypto.randomUUID();
    const title = options.title || `Comment Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      db,
      config,
      session,
      client,
      groupKeys,
      filePath: options.file,
      title,
      targetRecordId: commentId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'comment'),
      targetGroupIds: doc.group_ids || [],
      writeGroupId: doc.group_ids?.[0] || null,
    });
    const commentEnvelope = outboundComment(config.appNpub, session, groupKeys, doc, {
      recordId: commentId,
      body: options.body || '',
      parentCommentId: options.parent ?? null,
      anchorLineNumber: Number.isFinite(options.line) ? options.line : null,
      attachments: [attachment],
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [audioEnvelope, commentEnvelope]));
  });

docs.command('update')
  .argument('<docId>')
  .option('--title <title>')
  .option('--content <content>')
  .option('--content-file <path>')
  .option('--scope <scopeId>')
  .option('--clear-scope')
  .action(async (docId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const content = options.contentFile
      ? readFileSync(options.contentFile, 'utf8')
      : (typeof options.content === 'string' ? options.content : doc.content);
    const envelope = outboundDocument(config.appNpub, session, groupKeys, doc, {
      title: options.title ?? doc.title,
      content,
      ...resolveScopeLinkPatch(db, options.scope, options),
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

const audio = program.command('audio');
audio.command('list')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM audio_notes WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    const output = rows.map((row) => ({
      record_id: row.record_id,
      target_record_id: row.target_record_id,
      title: row.title,
      transcript_status: row.transcript_status,
      updated_at: row.updated_at,
    }));
    printResult(output);
  });

audio.command('show')
  .argument('<audioNoteId>')
  .action((audioNoteId) => {
    const db = openDb();
    const row = getRow(db, `SELECT * FROM audio_notes WHERE record_id = ?`, [audioNoteId]);
    if (!row) throw new Error(`Audio note not found: ${audioNoteId}`);
    printResult(parseRawRow(row) || row);
  });

audio.command('update-transcript')
  .argument('<audioNoteId>')
  .requiredOption('--transcript <text>')
  .option('--summary <text>')
  .option('--preview <text>')
  .option('--status <status>', 'pending|processing|done|failed', 'done')
  .action(async (audioNoteId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM audio_notes WHERE record_id = ?`, [audioNoteId]);
    if (!row) throw new Error(`Audio note not found: ${audioNoteId}`);
    const note = parseRawRow(row);
    const envelope = outboundAudioNote(config.appNpub, session, groupKeys, {
      recordId: note.record_id,
      ownerNpub: note.owner_npub,
      targetRecordId: note.target_record_id,
      targetRecordFamilyHash: note.target_record_family_hash,
      title: note.title,
      storageObjectId: note.storage_object_id,
      mimeType: note.mime_type,
      durationSeconds: note.duration_seconds,
      sizeBytes: note.size_bytes ?? 0,
      mediaEncryption: note.media_encryption ?? null,
      waveformPreview: note.waveform_preview ?? [],
      transcriptStatus: options.status || 'done',
      transcriptPreview: options.preview || String(options.transcript).trim().split(/\s+/).slice(0, 12).join(' '),
      transcript: options.transcript,
      summary: options.summary ?? note.summary ?? null,
      targetGroupIds: note.group_ids || [],
      version: (note.version ?? 1) + 1,
      previousVersion: note.version ?? 1,
      writeGroupNpub: note.group_ids?.[0] || null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

audio.command('transcribe')
  .argument('[audioNoteId]')
  .option('--pending', 'transcribe all pending audio notes when no id is provided')
  .option('--force', 're-transcribe even if transcript already exists')
  .option('--model <path>', 'path to a local whisper model', '/Users/mini/code/Sov Eng/ideapipe/whisper-models/ggml-medium.bin')
  .action(async (audioNoteId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const rows = audioNoteId
      ? [getRow(db, `SELECT * FROM audio_notes WHERE record_id = ?`, [audioNoteId])].filter(Boolean)
      : getRows(
          db,
          `SELECT * FROM audio_notes WHERE record_state != 'deleted' AND (? = 1 OR transcript_status = 'pending' OR transcript IS NULL OR transcript = '') ORDER BY updated_at DESC`,
          [options.force ? 1 : 0],
        );

    if (rows.length === 0) {
      printResult([]);
      return;
    }

    const output = [];
    for (const row of rows) {
      const note = parseRawRow(row);
      if (!note) continue;
      if (!options.force && note.transcript_status === 'done' && note.transcript) {
        output.push({
          record_id: note.record_id,
          skipped: true,
          reason: 'already transcribed',
        });
        continue;
      }

      const audioBuffer = await downloadAndDecryptAudioNote(client, note);
      const transcript = transcribeAudioBuffer(audioBuffer, note.record_id, note.mime_type, options.model);
      if (!transcript) {
        output.push({
          record_id: note.record_id,
          skipped: true,
          reason: 'empty transcript',
        });
        continue;
      }

      const preview = audioTranscriptPreview(transcript);
      const summary = audioTranscriptSummary(transcript);
      const envelope = outboundAudioNote(config.appNpub, session, groupKeys, {
        recordId: note.record_id,
        ownerNpub: note.owner_npub,
        targetRecordId: note.target_record_id,
        targetRecordFamilyHash: note.target_record_family_hash,
        title: note.title,
        storageObjectId: note.storage_object_id,
        mimeType: note.mime_type,
        durationSeconds: note.duration_seconds,
        sizeBytes: note.size_bytes ?? 0,
        mediaEncryption: note.media_encryption ?? null,
        waveformPreview: note.waveform_preview ?? [],
        transcriptStatus: 'done',
        transcriptPreview: preview,
        transcript,
        summary,
        targetGroupIds: note.group_ids || [],
        version: (note.version ?? 1) + 1,
        previousVersion: note.version ?? 1,
        writeGroupNpub: note.group_ids?.[0] || null,
      });

      await client.syncRecords([envelope]);
      output.push({
        record_id: note.record_id,
        transcript,
        transcript_preview: preview,
        summary,
      });
    }

    await syncWorkspace({ client, config, session, quiet: true });
    printResult(output);
  });

const scopes = program.command('scopes');
scopes.command('create')
  .requiredOption('--title <title>')
  .requiredOption('--level <level>', 'product|project|deliverable')
  .option('--description <description>')
  .option('--parent <scopeId>')
  .option('--product <scopeId>')
  .option('--project <scopeId>')
  .option('--group <groupRef>')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const { groupIds, shares } = resolveRecordSharesAndGroups({ db, explicitGroupRef: options.group ?? null });
    const hierarchy = resolveScopedHierarchy(db, {
      level: options.level,
      parentId: options.parent ?? null,
      productId: options.product ?? null,
      projectId: options.project ?? null,
    });
    const envelope = outboundScope(config.appNpub, session, groupKeys, {
      record_id: crypto.randomUUID(),
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      description: options.description ?? '',
      ...hierarchy,
      shares,
      group_ids: groupIds,
      version: 0,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

scopes.command('list')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM scopes WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    const output = rows.map((row) => ({
      record_id: row.record_id,
      level: row.level,
      title: row.title,
      parent_id: row.parent_id,
      product_id: row.product_id,
      project_id: row.project_id,
      group_ids: jsonField(row.group_ids_json),
      updated_at: row.updated_at,
    }));
    printResult(output);
  });

scopes.command('show')
  .argument('<scopeId>')
  .action((scopeId) => {
    const db = openDb();
    const row = findScopeRow(db, scopeId);
    if (!row) throw new Error(`Scope not found: ${scopeId}`);
    printResult(parseRawRow(row) || row);
  });

scopes.command('update')
  .argument('<scopeId>')
  .option('--title <title>')
  .option('--description <description>')
  .option('--level <level>', 'product|project|deliverable')
  .option('--parent <scopeId>')
  .option('--clear-parent')
  .option('--product <scopeId>')
  .option('--project <scopeId>')
  .option('--group <groupRef>')
  .action(async (scopeId, options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const row = findScopeRow(db, scopeId);
    if (!row) throw new Error(`Scope not found: ${scopeId}`);
    const scope = parseRawRow(row) || row;
    const patch = {};
    if (options.title !== undefined) patch.title = options.title;
    if (options.description !== undefined) patch.description = options.description;
    if (options.group !== undefined) {
      const { groupIds, shares } = resolveRecordSharesAndGroups({ db, explicitGroupRef: options.group });
      patch.group_ids = groupIds;
      patch.shares = shares;
    }
    if (
      options.level !== undefined
      || options.parent !== undefined
      || options.clearParent
      || options.product !== undefined
      || options.project !== undefined
    ) {
      Object.assign(
        patch,
        resolveScopedHierarchy(db, {
          level: options.level ?? scope.level,
          parentId: options.clearParent ? null : (options.parent ?? scope.parent_id ?? null),
          productId: options.product ?? scope.product_id ?? null,
          projectId: options.project ?? scope.project_id ?? null,
        })
      );
    }
    const envelope = outboundScope(config.appNpub, session, groupKeys, scope, patch);
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

const storage = program.command('storage');
storage.command('upload')
  .argument('<filePath>')
  .option('--group <groupRef...>')
  .option('--owner <npub>')
  .option('--markdown', 'print markdown image reference if image')
  .action(async (filePath, options) => {
    const { client, db, config } = await refreshClientAndState();
    const primaryGroup = getPrimaryGroup(db);
    const accessGroupIds = options.group?.length
      ? resolveStorageAccessGroupIds(db, options.group)
      : (primaryGroup?.group_id ? [primaryGroup.group_id] : []);
    const uploaded = await uploadFileToStorage(client, filePath, {
      ownerNpub: options.owner || config.workspaceOwnerNpub,
      accessGroupIds,
      contentType: detectMimeType(filePath),
      fileName: defaultFileName(filePath, 'upload'),
    });
    const output = {
      object_id: uploaded.object_id,
      file_name: uploaded.file_name,
      content_type: uploaded.content_type,
      size_bytes: uploaded.size_bytes,
      sha256_hex: uploaded.sha256_hex,
      storage_markdown: createStorageMarkdown(uploaded.object_id, uploaded.file_name),
    };
    printResult(options.markdown && !program.opts().json ? output.storage_markdown : output);
  });

const schedules = program.command('schedules');
schedules.command('create')
  .requiredOption('--title <title>')
  .option('--description <description>')
  .option('--start <HH:MM>', 'time_start')
  .option('--end <HH:MM>', 'time_end')
  .option('--days <days>', 'comma-separated days e.g. mon,tue,wed')
  .option('--timezone <tz>', 'IANA timezone', 'Australia/Perth')
  .option('--assign <groupRef>', 'assigned group')
  .option('--repeat <repeat>', 'daily|weekly|once', 'daily')
  .option('--board <groupRef>', 'group reference')
  .action(async (options) => {
    const { client, db, config, session, groupKeys } = await refreshClientAndState();
    const assignedGroup = options.assign
      ? findGroupByRef(db, options.assign)
      : null;
    const primaryGroup = assignedGroup || (options.board
      ? findGroupByRef(db, options.board)
      : requirePrimaryGroup(db));
    if (!primaryGroup) throw new Error(`Group not found: ${options.board}`);
    const groupId = primaryGroup.group_id;
    const shares = buildDefaultGroupShares(primaryGroup, primaryGroup.name || '');
    const days = options.days ? options.days.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : [];
    const envelope = outboundSchedule(config.appNpub, session, groupKeys, {
      record_id: crypto.randomUUID(),
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      description: options.description ?? '',
      time_start: options.start ?? null,
      time_end: options.end ?? null,
      days,
      timezone: options.timezone,
      assigned_group_id: groupId,
      active: true,
      last_run: null,
      repeat: options.repeat,
      shares,
      group_ids: [groupId],
      board_group_id: groupId,
      version: 0,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

schedules.command('list')
  .action(() => {
    const db = openDb();
    const rows = getRows(db, `SELECT * FROM schedules WHERE record_state != 'deleted' ORDER BY updated_at DESC`);
    const output = rows.map((row) => ({
      record_id: row.record_id,
      title: row.title,
      time_start: row.time_start,
      time_end: row.time_end,
      days: jsonField(row.days_json),
      timezone: row.timezone,
      assigned_group_id: row.assigned_group_id ?? null,
      active: Boolean(row.active),
      repeat: row.repeat,
      last_run: row.last_run,
      updated_at: row.updated_at,
    }));
    if (program.opts().json) console.log(JSON.stringify(output, null, 2));
    else output.forEach((row) => console.log(`${row.record_id} | ${row.active ? 'active' : 'inactive'} | ${row.title} | ${row.time_start ?? ''}-${row.time_end ?? ''} | ${(row.days || []).join(',')}`));
  });

schedules.command('show')
  .argument('<scheduleId>')
  .action((scheduleId) => {
    const db = openDb();
    const row = getRow(db, `SELECT * FROM schedules WHERE record_id = ?`, [scheduleId]);
    if (!row) throw new Error(`Schedule not found: ${scheduleId}`);
    const parsed = parseRawRow(row) || row;
    if (program.opts().json) console.log(JSON.stringify(parsed, null, 2));
    else console.log(parsed);
  });

schedules.command('update')
  .argument('<scheduleId>')
  .option('--title <title>')
  .option('--description <description>')
  .option('--start <HH:MM>')
  .option('--end <HH:MM>')
  .option('--days <days>', 'comma-separated days')
  .option('--timezone <tz>')
  .option('--assign <groupRef>')
  .option('--clear-assignee')
  .option('--active <bool>', 'true or false')
  .option('--repeat <repeat>')
  .option('--last-run <iso>')
  .action(async (scheduleId, options) => {
    let { client, db, config, session, groupKeys } = getClientAndState();
    await syncWorkspace({ client, config, session, quiet: true });
    ({ client, db, config, session, groupKeys } = getClientAndState());
    const row = getRow(db, `SELECT * FROM schedules WHERE record_id = ?`, [scheduleId]);
    if (!row) throw new Error(`Schedule not found: ${scheduleId}`);
    const schedule = JSON.parse(row.raw_json);
    const patch = {};
    if (options.title !== undefined) patch.title = options.title;
    if (options.description !== undefined) patch.description = options.description;
    if (options.start !== undefined) patch.time_start = options.start;
    if (options.end !== undefined) patch.time_end = options.end;
    if (options.days !== undefined) patch.days = options.days.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (options.timezone !== undefined) patch.timezone = options.timezone;
    if (options.assign !== undefined || options.clearAssignee) {
      const assignedGroup = options.assign ? findGroupByRef(db, options.assign) : null;
      patch.assigned_group_id = options.clearAssignee
        ? null
        : assignedGroup?.group_id ?? null;
      if (options.assign && !patch.assigned_group_id) throw new Error(`Group not found: ${options.assign}`);
      if (patch.assigned_group_id) {
        patch.group_ids = [patch.assigned_group_id];
        patch.shares = buildDefaultGroupShares(assignedGroup, assignedGroup?.name || '');
      }
    }
    if (options.active !== undefined) patch.active = options.active === 'true';
    if (options.repeat !== undefined) patch.repeat = options.repeat;
    if (options.lastRun !== undefined) patch.last_run = options.lastRun;
    const envelope = outboundSchedule(config.appNpub, session, groupKeys, schedule, patch);
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

schedules.command('toggle')
  .argument('<scheduleId>')
  .action(async (scheduleId) => {
    let { client, db, config, session, groupKeys } = getClientAndState();
    await syncWorkspace({ client, config, session, quiet: true });
    ({ client, db, config, session, groupKeys } = getClientAndState());
    const row = getRow(db, `SELECT * FROM schedules WHERE record_id = ?`, [scheduleId]);
    if (!row) throw new Error(`Schedule not found: ${scheduleId}`);
    const schedule = JSON.parse(row.raw_json);
    const envelope = outboundSchedule(config.appNpub, session, groupKeys, schedule, {
      active: !schedule.active,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
