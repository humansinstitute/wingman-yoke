import { getMeta, openDb, putMeta, replaceGroupKeys, replaceGroups, upsertRows } from './db.js';
import {
  decryptRecordPayload,
  inboundAudioNote,
  inboundChannel,
  inboundChatMessage,
  inboundComment,
  inboundDirectory,
  inboundDocument,
  inboundGroup,
  inboundReport,
  inboundSchedule,
  inboundScope,
  inboundTask,
  loadGroupKeyMap,
  recordFamilyHash,
} from './translators.js';
import { decodeNsec, getSession } from './nostr.js';

export const FAMILY_TABLES = [
  { collection: 'channel', table: 'channels', mapper: inboundChannel },
  { collection: 'chat_message', table: 'messages', mapper: inboundChatMessage },
  { collection: 'directory', table: 'directories', mapper: inboundDirectory },
  { collection: 'document', table: 'documents', mapper: inboundDocument },
  { collection: 'report', table: 'reports', mapper: inboundReport },
  { collection: 'task', table: 'tasks', mapper: inboundTask },
  { collection: 'comment', table: 'comments', mapper: inboundComment },
  { collection: 'audio_note', table: 'audio_notes', mapper: inboundAudioNote },
  { collection: 'scope', table: 'scopes', mapper: inboundScope },
  { collection: 'schedule', table: 'schedules', mapper: inboundSchedule },
];

function json(value) {
  return JSON.stringify(value ?? null);
}

function newerIsoTimestamp(current, candidate) {
  const currentTs = Date.parse(current || '');
  const candidateTs = Date.parse(candidate || '');
  if (!Number.isFinite(candidateTs)) return current || null;
  if (!Number.isFinite(currentTs) || candidateTs > currentTs) return candidate;
  return current || null;
}

function rowForTable(table, mapped, rawRecord) {
  const common = {
    raw_json: json(mapped),
  };
  switch (table) {
    case 'channels':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        group_ids_json: json(mapped.group_ids),
        participant_npubs_json: json(mapped.participant_npubs),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'messages':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        channel_id: mapped.channel_id,
        parent_message_id: mapped.parent_message_id,
        body: mapped.body,
        attachments_json: json(mapped.attachments),
        sender_npub: mapped.sender_npub,
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'tasks':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        description: mapped.description,
        state: mapped.state,
        priority: mapped.priority,
        assigned_to_npub: mapped.assigned_to_npub,
        parent_task_id: mapped.parent_task_id,
        board_group_id: mapped.board_group_id,
        scheduled_for: mapped.scheduled_for,
        tags: mapped.tags,
        scope_id: mapped.scope_id,
        scope_l1_id: mapped.scope_l1_id,
        scope_l2_id: mapped.scope_l2_id,
        scope_l3_id: mapped.scope_l3_id,
        scope_l4_id: mapped.scope_l4_id,
        scope_l5_id: mapped.scope_l5_id,
        references_json: json(mapped.references),
        group_ids_json: json(mapped.group_ids),
        shares_json: json(mapped.shares),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'comments':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        target_record_id: mapped.target_record_id,
        target_record_family_hash: mapped.target_record_family_hash,
        parent_comment_id: mapped.parent_comment_id,
        anchor_line_number: mapped.anchor_line_number,
        comment_status: mapped.comment_status,
        body: mapped.body,
        attachments_json: json(mapped.attachments),
        sender_npub: mapped.sender_npub,
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'documents':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        content: mapped.content,
        parent_directory_id: mapped.parent_directory_id,
        scope_id: mapped.scope_id,
        scope_l1_id: mapped.scope_l1_id,
        scope_l2_id: mapped.scope_l2_id,
        scope_l3_id: mapped.scope_l3_id,
        scope_l4_id: mapped.scope_l4_id,
        scope_l5_id: mapped.scope_l5_id,
        group_ids_json: json(mapped.group_ids),
        shares_json: json(mapped.shares),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'directories':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        parent_directory_id: mapped.parent_directory_id,
        scope_id: mapped.scope_id,
        scope_l1_id: mapped.scope_l1_id,
        scope_l2_id: mapped.scope_l2_id,
        scope_l3_id: mapped.scope_l3_id,
        scope_l4_id: mapped.scope_l4_id,
        scope_l5_id: mapped.scope_l5_id,
        group_ids_json: json(mapped.group_ids),
        shares_json: json(mapped.shares),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'reports':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        declaration_type: mapped.declaration_type,
        surface: mapped.surface,
        generated_at: mapped.generated_at,
        payload_json: json(mapped.payload),
        scope_id: mapped.scope_id,
        scope_level: mapped.scope_level,
        scope_l1_id: mapped.scope_l1_id,
        scope_l2_id: mapped.scope_l2_id,
        scope_l3_id: mapped.scope_l3_id,
        scope_l4_id: mapped.scope_l4_id,
        scope_l5_id: mapped.scope_l5_id,
        group_ids_json: json(mapped.group_ids),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'audio_notes':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        target_record_id: mapped.target_record_id,
        target_record_family_hash: mapped.target_record_family_hash,
        title: mapped.title,
        storage_object_id: mapped.storage_object_id,
        mime_type: mapped.mime_type,
        duration_seconds: mapped.duration_seconds,
        size_bytes: mapped.size_bytes ?? 0,
        media_encryption_json: json(mapped.media_encryption),
        waveform_preview_json: json(mapped.waveform_preview),
        transcript_status: mapped.transcript_status,
        transcript_preview: mapped.transcript_preview,
        transcript: mapped.transcript,
        summary: mapped.summary,
        sender_npub: mapped.sender_npub ?? null,
        group_ids_json: json(mapped.group_ids),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'scopes':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        level: mapped.level,
        title: mapped.title,
        description: mapped.description,
        parent_id: mapped.parent_id,
        l1_id: mapped.l1_id,
        l2_id: mapped.l2_id,
        l3_id: mapped.l3_id,
        l4_id: mapped.l4_id,
        l5_id: mapped.l5_id,
        group_ids_json: json(mapped.group_ids),
        shares_json: json(mapped.shares),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    case 'schedules':
      return {
        record_id: mapped.record_id,
        owner_npub: mapped.owner_npub,
        title: mapped.title,
        description: mapped.description,
        time_start: mapped.time_start,
        time_end: mapped.time_end,
        days_json: json(mapped.days),
        timezone: mapped.timezone,
        assigned_group_id: mapped.assigned_group_id,
        active: mapped.active ? 1 : 0,
        last_run: mapped.last_run,
        repeat: mapped.repeat,
        group_ids_json: json(mapped.group_ids),
        shares_json: json(mapped.shares),
        record_state: mapped.record_state,
        version: mapped.version,
        updated_at: mapped.updated_at,
        ...common,
      };
    default:
      throw new Error(`Unsupported table ${table}`);
  }
}

export async function syncWorkspace({ client, config, session, quiet = false }) {
  const db = openDb();
  const groupsResult = await client.getGroups();
  const groups = (groupsResult.groups ?? []).map(inboundGroup);
  replaceGroups(db, groups.map((group) => ({
    group_id: group.group_id,
    current_group_npub: group.current_group_npub ?? group.group_npub ?? null,
    current_epoch: group.current_epoch ?? 1,
    owner_npub: group.owner_npub,
    name: group.name,
    group_kind: group.group_kind,
    private_member_npub: group.private_member_npub,
    member_npubs_json: json(group.member_npubs),
    raw_json: json(group),
    synced_at: new Date().toISOString(),
  })));

  const keysResult = await client.getGroupKeys();
  const keyRows = (keysResult.keys ?? []).map((entry) => ({
    group_id: entry.group_id ?? entry.group_npub ?? null,
    key_version: entry.key_version ?? entry.epoch ?? 1,
    group_npub: entry.group_npub,
    wrapped_group_nsec: entry.wrapped_group_nsec,
    wrapped_by_npub: entry.wrapped_by_npub,
    raw_json: json(entry),
    synced_at: new Date().toISOString(),
  }));
  replaceGroupKeys(db, keyRows);
  const groupKeyMap = loadGroupKeyMap(session, keyRows, decodeNsec);

  const counts = { groups: groups.length, group_keys: keyRows.length };
  for (const family of FAMILY_TABLES) {
    const hash = recordFamilyHash(config.appNpub, family.collection);
    const since = getMeta(db, `sync:${family.collection}:at`);
    const result = await client.fetchRecords(hash, since);
    const rows = [];
    let latestAppliedAt = since;
    for (const record of result.records ?? []) {
      try {
        const payload = decryptRecordPayload(record, session, groupKeyMap);
        const mapped = family.mapper(record, payload);
        rows.push(rowForTable(family.table, mapped, record));
        latestAppliedAt = newerIsoTimestamp(
          latestAppliedAt,
          record.updated_at ?? mapped.updated_at ?? null,
        );
      } catch (error) {
        if (!quiet) {
          console.warn(`Skipping undecryptable ${family.collection} record ${record.record_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    upsertRows(db, family.table, rows);
    counts[family.collection] = rows.length;
    if (latestAppliedAt && latestAppliedAt !== since) {
      putMeta(db, `sync:${family.collection}:at`, latestAppliedAt);
    }
  }

  putMeta(db, 'sync:last_at', new Date().toISOString());
  return counts;
}

export function getSyncStatus(db) {
  return {
    lastSyncAt: getMeta(db, 'sync:last_at'),
  };
}
