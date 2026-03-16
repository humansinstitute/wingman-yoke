#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { initConfigFromToken, loadConfig } from './config.js';
import { getMeta, getRow, getRows, openDb } from './db.js';
import { resolveStorageLinks } from './render.js';
import { SuperbasedClient } from './client.js';
import { decodeNsec, getSession } from './nostr.js';
import { createStorageMarkdown, defaultFileName, detectMimeType, uploadEncryptedAudioToStorage, uploadFileToStorage } from './storage.js';
import { syncWorkspace } from './sync.js';
import { loadGroupKeyMap, makeGroupWriteShare, outboundAudioNote, outboundChannel, outboundChatMessage, outboundComment, outboundDocument, outboundTask, recordFamilyHash } from './translators.js';

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error('No config found. Run `wingman-autopilot init --token <token>` first.');
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
  const keyRows = getRows(db, `SELECT * FROM group_keys_cache ORDER BY group_npub`);
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
  return getRow(db, `SELECT * FROM groups_cache ORDER BY name ASC, group_npub ASC LIMIT 1`);
}

function requirePrimaryGroup(db) {
  const row = getPrimaryGroup(db);
  if (!row) throw new Error('No accessible groups found. Run sync first or share a group to this agent.');
  return row;
}

function buildDefaultGroupShares(groupNpub, label = '') {
  return [makeGroupWriteShare(groupNpub, label)];
}

function findCommentRow(db, commentId) {
  return getRow(db, `SELECT * FROM comments WHERE record_id = ?`, [commentId]);
}

function maybeParseInt(value) {
  if (value == null || value === '') return null;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

async function createAudioAttachmentBatch({ config, session, client, filePath, title, targetRecordId, targetRecordFamilyHash, targetGroupIds, writeGroupNpub }) {
  const uploaded = await uploadEncryptedAudioToStorage(client, filePath, {
    ownerNpub: config.workspaceOwnerNpub,
    accessGroupNpubs: targetGroupIds,
    contentType: detectMimeType(filePath, 'audio/webm'),
    fileName: defaultFileName(filePath, 'voice-note'),
  });
  const audioRecordId = crypto.randomUUID();
  const audioEnvelope = outboundAudioNote(config.appNpub, session, {
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
    writeGroupNpub,
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

const program = new Command();
program
  .name('wingman-autopilot')
  .description('Agent-first CLI for Coworker v4 / SuperBased')
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

const tasks = program.command('tasks');
tasks.command('create')
  .requiredOption('--title <title>')
  .option('--description <description>')
  .option('--state <state>', 'task state', 'new')
  .option('--priority <priority>', 'task priority', 'sand')
  .option('--tags <tags>')
  .option('--scheduled-for <date>')
  .option('--parent <taskId>')
  .option('--group <groupNpub>')
  .action(async (options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const primaryGroup = options.group
      ? getRow(db, `SELECT * FROM groups_cache WHERE group_npub = ?`, [options.group])
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const recordId = crypto.randomUUID();
    const groupNpub = primaryGroup.group_npub;
    const shares = buildDefaultGroupShares(groupNpub, primaryGroup.name || '');
    const envelope = outboundTask(config.appNpub, session, {
      record_id: recordId,
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      description: options.description ?? '',
      state: options.state ?? 'new',
      priority: options.priority ?? 'sand',
      parent_task_id: options.parent ?? null,
      board_group_id: groupNpub,
      scheduled_for: options.scheduledFor ?? null,
      tags: options.tags ?? '',
      shares,
      group_ids: [groupNpub],
      version: 0,
      signature_npub: session.npub,
      write_group_npub: groupNpub,
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
      scheduled_for: row.scheduled_for,
      group_ids: jsonField(row.group_ids_json),
      updated_at: row.updated_at,
    }));
    if (program.opts().json) console.log(JSON.stringify(output, null, 2));
    else output.forEach((row) => console.log(`${row.record_id} | ${row.state} | ${row.title}`));
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
  .option('--tags <tags>')
  .option('--scheduled-for <date>')
  .action(async (taskId, options) => {
    let { client, db, config, session } = getClientAndState();
    await syncWorkspace({ client, config, session, quiet: true });
    ({ client, db, config, session } = getClientAndState());
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = JSON.parse(row.raw_json);
    const envelope = outboundTask(config.appNpub, session, task, {
      title: options.title ?? task.title,
      description: options.description ?? task.description,
      state: options.state ?? task.state,
      priority: options.priority ?? task.priority,
      tags: options.tags ?? task.tags,
      scheduled_for: options.scheduledFor ?? task.scheduled_for,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

tasks.command('comment')
  .argument('<taskId>')
  .requiredOption('--body <body>')
  .option('--parent <commentId>', 'parent comment id for thread reply')
  .action(async (taskId, options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const envelope = outboundComment(config.appNpub, session, task, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const parentComment = findCommentRow(db, commentId);
    if (!parentComment) throw new Error(`Comment not found: ${commentId}`);
    const taskRow = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [parentComment.target_record_id]);
    if (!taskRow) throw new Error(`Target task not found: ${parentComment.target_record_id}`);
    const task = parseRawRow(taskRow);
    const envelope = outboundComment(config.appNpub, session, task, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const commentId = crypto.randomUUID();
    const title = options.title || `Task Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      config,
      session,
      client,
      filePath: options.file,
      title,
      targetRecordId: commentId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'comment'),
      targetGroupIds: task.group_ids || [],
      writeGroupNpub: task.board_group_id || task.group_ids?.[0] || null,
    });
    const commentEnvelope = outboundComment(config.appNpub, session, task, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM tasks WHERE record_id = ?`, [taskId]);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const task = parseRawRow(row);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupNpubs: task.group_ids || [],
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'task-comment-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundComment(config.appNpub, session, task, {
      recordId: crypto.randomUUID(),
      body,
      parentCommentId: options.parent ?? null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

const chat = program.command('chat');
chat.command('create')
  .requiredOption('--title <title>')
  .option('--group <groupNpub>')
  .option('--participant <npub...>', 'participant npubs')
  .action(async (options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const primaryGroup = options.group
      ? getRow(db, `SELECT * FROM groups_cache WHERE group_npub = ?`, [options.group])
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const groupNpub = primaryGroup.group_npub;
    const participantNpubs = [...new Set([session.npub, ...(options.participant || [])].filter(Boolean))];
    const envelope = outboundChannel(config.appNpub, session, {
      recordId: crypto.randomUUID(),
      ownerNpub: config.workspaceOwnerNpub,
      title: options.title,
      groupIds: [groupNpub],
      participantNpubs,
      version: 1,
      previousVersion: 0,
      writeGroupNpub: groupNpub,
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
    const { client, db, config, session } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const envelope = outboundChatMessage(config.appNpub, session, channel, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const envelope = outboundChatMessage(config.appNpub, session, channel, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupNpubs: channel.group_ids || [],
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'chat-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundChatMessage(config.appNpub, session, channel, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const channelRow = getRow(db, `SELECT * FROM channels WHERE record_id = ?`, [channelId]);
    if (!channelRow) throw new Error(`Channel not found: ${channelId}`);
    const channel = parseRawRow(channelRow);
    const messageId = crypto.randomUUID();
    const title = options.title || `Chat Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      config,
      session,
      client,
      filePath: options.file,
      title,
      targetRecordId: messageId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'chat_message'),
      targetGroupIds: channel.group_ids || [],
      writeGroupNpub: channel.group_ids?.[0] || null,
    });
    const messageEnvelope = outboundChatMessage(config.appNpub, session, channel, {
      recordId: messageId,
      body: options.body || '',
      parentMessageId: options.thread ?? null,
      attachments: [attachment],
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [audioEnvelope, messageEnvelope]));
  });

const docs = program.command('docs');
docs.command('create')
  .requiredOption('--title <title>')
  .option('--content <content>', '', '')
  .option('--content-file <path>')
  .option('--group <groupNpub>')
  .option('--parent-directory <directoryId>')
  .action(async (options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const primaryGroup = options.group
      ? getRow(db, `SELECT * FROM groups_cache WHERE group_npub = ?`, [options.group])
      : requirePrimaryGroup(db);
    if (!primaryGroup) throw new Error(`Group not found: ${options.group}`);
    const groupNpub = primaryGroup.group_npub;
    const shares = buildDefaultGroupShares(groupNpub, primaryGroup.name || '');
    const content = options.contentFile ? readFileSync(options.contentFile, 'utf8') : options.content;
    const envelope = outboundDocument(config.appNpub, session, {
      record_id: crypto.randomUUID(),
      owner_npub: config.workspaceOwnerNpub,
      title: options.title,
      content: content ?? '',
      parent_directory_id: options.parentDirectory ?? null,
      shares,
      group_ids: [groupNpub],
      version: 0,
      signature_npub: session.npub,
      write_group_npub: groupNpub,
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const envelope = outboundComment(config.appNpub, session, doc, {
      recordId: crypto.randomUUID(),
      body: options.body,
      parentCommentId: options.parent ?? null,
      anchorLineNumber: Number.isFinite(options.line) ? options.line : null,
    });
    printResult(await syncRecordsAndRefresh(client, config, session, [envelope]));
  });

docs.command('reply')
  .argument('<commentId>')
  .requiredOption('--body <body>')
  .action(async (commentId, options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const parentComment = findCommentRow(db, commentId);
    if (!parentComment) throw new Error(`Comment not found: ${commentId}`);
    const docRow = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [parentComment.target_record_id]);
    if (!docRow) throw new Error(`Target document not found: ${parentComment.target_record_id}`);
    const doc = parseRawRow(docRow);
    const envelope = outboundComment(config.appNpub, session, doc, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const uploaded = await uploadFileToStorage(client, options.file, {
      ownerNpub: config.workspaceOwnerNpub,
      accessGroupNpubs: doc.group_ids || [],
      contentType: detectMimeType(options.file, 'image/png'),
      fileName: defaultFileName(options.file, 'doc-comment-image'),
    });
    const markdown = createStorageMarkdown(uploaded.object_id, uploaded.file_name);
    const body = options.body ? `${options.body}\n\n${markdown}` : markdown;
    const envelope = outboundComment(config.appNpub, session, doc, {
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const commentId = crypto.randomUUID();
    const title = options.title || `Comment Voice: ${new Date().toISOString()}`;
    const { audioEnvelope, attachment } = await createAudioAttachmentBatch({
      config,
      session,
      client,
      filePath: options.file,
      title,
      targetRecordId: commentId,
      targetRecordFamilyHash: recordFamilyHash(config.appNpub, 'comment'),
      targetGroupIds: doc.group_ids || [],
      writeGroupNpub: doc.group_ids?.[0] || null,
    });
    const commentEnvelope = outboundComment(config.appNpub, session, doc, {
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
  .action(async (docId, options) => {
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM documents WHERE record_id = ?`, [docId]);
    if (!row) throw new Error(`Document not found: ${docId}`);
    const doc = parseRawRow(row);
    const content = options.contentFile
      ? readFileSync(options.contentFile, 'utf8')
      : (typeof options.content === 'string' ? options.content : doc.content);
    const envelope = outboundDocument(config.appNpub, session, doc, {
      title: options.title ?? doc.title,
      content,
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
    const { client, db, config, session } = await refreshClientAndState();
    const row = getRow(db, `SELECT * FROM audio_notes WHERE record_id = ?`, [audioNoteId]);
    if (!row) throw new Error(`Audio note not found: ${audioNoteId}`);
    const note = parseRawRow(row);
    const envelope = outboundAudioNote(config.appNpub, session, {
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

const storage = program.command('storage');
storage.command('upload')
  .argument('<filePath>')
  .option('--group <groupNpub...>')
  .option('--owner <npub>')
  .option('--markdown', 'print markdown image reference if image')
  .action(async (filePath, options) => {
    const { client, db, config } = await refreshClientAndState();
    const accessGroupNpubs = options.group?.length
      ? options.group
      : (getPrimaryGroup(db)?.group_npub ? [getPrimaryGroup(db).group_npub] : []);
    const uploaded = await uploadFileToStorage(client, filePath, {
      ownerNpub: options.owner || config.workspaceOwnerNpub,
      accessGroupNpubs,
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

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
