import { decryptFromNpub, encodeNsec, encryptForNpub } from './nostr.js';

function parseCiphertextEnvelope(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && typeof parsed.ciphertext === 'string') {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function parsePayloadJson(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function normalizeShares(dataShares = [], groupPayloads = []) {
  if (Array.isArray(dataShares) && dataShares.length > 0) {
    return dataShares.map((share) => ({
      type: share.type === 'person' ? 'person' : 'group',
      key: share.key ?? (share.type === 'person' ? share.person_npub : share.group_npub),
      access: share.access === 'write' ? 'write' : 'read',
      label: share.label ?? '',
      person_npub: share.person_npub ?? null,
      group_npub: share.group_npub ?? null,
      via_group_npub: share.via_group_npub ?? null,
      inherited: share.inherited === true,
      inherited_from_directory_id: share.inherited_from_directory_id ?? null,
    }));
  }

  return groupPayloads.map((payload) => ({
    type: 'group',
    key: payload.group_npub,
    access: payload.write ? 'write' : 'read',
    label: '',
    person_npub: null,
    group_npub: payload.group_npub,
    via_group_npub: null,
    inherited: false,
    inherited_from_directory_id: null,
  }));
}

export function recordFamilyHash(appNpub, collectionSpace) {
  return `${appNpub}:${collectionSpace}`;
}

export function unwrapGroupKey(session, keyRow) {
  const nsec = decryptFromNpub(session.secret, keyRow.wrapped_by_npub, keyRow.wrapped_group_nsec);
  return {
    groupNpub: keyRow.group_npub,
    keyVersion: keyRow.key_version ?? 1,
    nsec,
    secret: session.constructor?.decodeNsec ? session.constructor.decodeNsec(nsec) : null,
  };
}

export function loadGroupKeyMap(session, keyRows, decodeNsec) {
  const map = new Map();
  for (const row of keyRows) {
    const nsec = decryptFromNpub(session.secret, row.wrapped_by_npub, row.wrapped_group_nsec);
    map.set(row.group_npub, {
      groupNpub: row.group_npub,
      groupId: row.group_id,
      keyVersion: row.key_version ?? 1,
      nsec,
      secret: decodeNsec(nsec),
    });
  }
  return map;
}

export function decryptRecordPayload(record, session, groupKeys) {
  const ownerCiphertext = record.owner_payload?.ciphertext ?? record.owner_payload;
  if (ownerCiphertext && record.owner_npub === session.npub) {
    return parsePayloadJson(decryptFromNpub(session.secret, record.signature_npub || record.owner_npub, ownerCiphertext));
  }

  for (const payload of (record.group_payloads || [])) {
    const keyEntry = groupKeys.get(payload.group_npub);
    if (!keyEntry) continue;
    const envelope = parseCiphertextEnvelope(payload.ciphertext);
    const senderNpub = envelope?.encrypted_by_npub || record.signature_npub || payload.group_npub;
    const ciphertext = envelope?.ciphertext || payload.ciphertext;
    return parsePayloadJson(decryptFromNpub(keyEntry.secret, senderNpub, ciphertext));
  }

  throw new Error(`Unable to decrypt record ${record.record_id}: no matching group key`);
}

function normalizeRecordState(data) {
  return data.record_state ?? 'active';
}

export function inboundGroup(group) {
  return {
    group_npub: group.group_npub ?? group.id,
    group_id: group.id ?? group.group_id ?? group.group_npub,
    owner_npub: group.owner_npub,
    name: group.name ?? '',
    group_kind: group.group_kind || 'shared',
    private_member_npub: group.private_member_npub ?? null,
    member_npubs: [...(group.members ?? group.member_npubs ?? [])].map((member) => typeof member === 'string' ? member : member.member_npub).filter(Boolean),
  };
}

export function inboundChannel(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? '',
    group_ids: (record.group_payloads || []).map((gp) => gp.group_npub),
    participant_npubs: Array.isArray(data.participant_npubs) ? data.participant_npubs : [record.owner_npub],
    scope_id: data.scope_id ?? null,
    scope_product_id: data.scope_product_id ?? null,
    scope_project_id: data.scope_project_id ?? null,
    scope_deliverable_id: data.scope_deliverable_id ?? null,
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundChatMessage(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    channel_id: data.channel_id,
    parent_message_id: data.parent_message_id ?? null,
    body: data.body ?? '',
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    sender_npub: record.signature_npub ?? record.owner_npub,
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundTask(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? '',
    description: data.description ?? '',
    state: data.state ?? 'new',
    priority: data.priority ?? 'sand',
    parent_task_id: data.parent_task_id ?? null,
    board_group_id: data.board_group_id ?? null,
    scheduled_for: data.scheduled_for ?? null,
    tags: data.tags ?? '',
    shares: data.shares ?? [],
    group_ids: (record.group_payloads || []).map((gp) => gp.group_npub),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundComment(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    target_record_id: data.target_record_id ?? null,
    target_record_family_hash: data.target_record_family_hash ?? null,
    parent_comment_id: data.parent_comment_id ?? null,
    anchor_line_number: Number.isFinite(Number(data.anchor_line_number)) ? Number(data.anchor_line_number) : null,
    comment_status: data.comment_status === 'resolved' ? 'resolved' : 'open',
    body: data.body ?? '',
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    sender_npub: record.signature_npub ?? record.owner_npub,
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundDirectory(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? 'Untitled directory',
    parent_directory_id: data.parent_directory_id ?? null,
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: (record.group_payloads || []).map((gp) => gp.group_npub),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundDocument(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? 'Untitled document',
    content: data.content ?? '',
    parent_directory_id: data.parent_directory_id ?? null,
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: (record.group_payloads || []).map((gp) => gp.group_npub),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundAudioNote(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    target_record_id: data.target_record_id ?? null,
    target_record_family_hash: data.target_record_family_hash ?? null,
    title: data.title ?? 'Voice note',
    storage_object_id: data.storage_object_id ?? null,
    mime_type: data.mime_type ?? 'audio/webm;codecs=opus',
    duration_seconds: Number.isFinite(Number(data.duration_seconds)) ? Number(data.duration_seconds) : null,
    size_bytes: Number.isFinite(Number(data.size_bytes)) ? Number(data.size_bytes) : 0,
    media_encryption: data.media_encryption ?? null,
    waveform_preview: Array.isArray(data.waveform_preview) ? data.waveform_preview : [],
    transcript_status: data.transcript_status ?? 'pending',
    transcript_preview: data.transcript_preview ?? null,
    transcript: data.transcript ?? null,
    summary: data.summary ?? null,
    sender_npub: record.signature_npub ?? record.owner_npub,
    group_ids: (record.group_payloads || []).map((gp) => gp.group_npub),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundScope(record, payload) {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    level: data.level ?? null,
    title: data.title ?? '',
    description: data.description ?? '',
    parent_id: data.parent_id ?? null,
    product_id: data.product_id ?? null,
    project_id: data.project_id ?? null,
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function makeGroupWriteShare(groupNpub, label = '') {
  return {
    type: 'group',
    key: groupNpub,
    access: 'write',
    label,
    person_npub: null,
    group_npub: groupNpub,
    via_group_npub: null,
    inherited: false,
    inherited_from_directory_id: null,
  };
}

export function encryptOwnerPayload(ownerNpub, plaintext, session) {
  return { ciphertext: encryptForNpub(session.secret, ownerNpub, plaintext) };
}

function buildGroupPayloads(groupIds, plaintext, session, canWriteMap = null) {
  const uniqueGroups = [...new Set((groupIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  return uniqueGroups.map((groupNpub) => ({
    group_npub: groupNpub,
    ciphertext: JSON.stringify({
      encrypted_by_npub: session.npub,
      ciphertext: encryptForNpub(session.secret, groupNpub, plaintext),
    }),
    write: canWriteMap instanceof Map ? canWriteMap.get(groupNpub) === true : true,
  }));
}

function selectWriteGroup(session, resource, fallbackGroupId = null) {
  const explicit = String(fallbackGroupId || '').trim();
  if (explicit) return explicit;
  const shares = Array.isArray(resource?.shares) ? resource.shares : [];
  const directPersonShare = shares.find((share) => (
    share?.person_npub === session.npub
    && share?.access === 'write'
    && typeof share?.via_group_npub === 'string'
    && share.via_group_npub.trim()
  ));
  if (directPersonShare?.via_group_npub) return directPersonShare.via_group_npub;
  const writableGroupShare = shares.find((share) => (
    share?.group_npub
    && share?.access === 'write'
  ));
  if (writableGroupShare?.group_npub) return writableGroupShare.group_npub;
  return resource?.group_ids?.find(Boolean) || undefined;
}

export function outboundChatMessage(appNpub, session, channel, {
  recordId,
  body,
  parentMessageId = null,
  attachments = [],
  version = 1,
  previousVersion = 0,
  recordState = 'active',
}) {
  const payload = {
    app_namespace: appNpub,
    collection_space: 'chat_message',
    schema_version: 1,
    record_id: recordId,
    data: {
      channel_id: channel.record_id,
      parent_message_id: parentMessageId,
      body,
      attachments,
      record_state: recordState,
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: recordId,
    owner_npub: channel.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'chat_message'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_npub: selectWriteGroup(session, channel),
    owner_payload: encryptOwnerPayload(channel.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(channel.group_ids || [], plaintext, session),
  };
}

export function outboundChannel(appNpub, session, {
  recordId,
  ownerNpub,
  title,
  groupIds = [],
  participantNpubs = [],
  scopeId = null,
  scopeProductId = null,
  scopeProjectId = null,
  scopeDeliverableId = null,
  version = 1,
  previousVersion = 0,
  writeGroupNpub = null,
  recordState = 'active',
}) {
  const payload = {
    app_namespace: appNpub,
    collection_space: 'channel',
    schema_version: 1,
    record_id: recordId,
    data: {
      title,
      participant_npubs: participantNpubs,
      scope_id: scopeId,
      scope_product_id: scopeProductId,
      scope_project_id: scopeProjectId,
      scope_deliverable_id: scopeDeliverableId,
      record_state: recordState,
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    record_family_hash: recordFamilyHash(appNpub, 'channel'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_npub: writeGroupNpub || selectWriteGroup(session, { group_ids: groupIds }),
    owner_payload: encryptOwnerPayload(ownerNpub, plaintext, session),
    group_payloads: buildGroupPayloads(groupIds || [], plaintext, session),
  };
}

export function outboundTask(appNpub, session, task, patch = {}) {
  const next = { ...task, ...patch };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'task',
    schema_version: 1,
    record_id: task.record_id,
    data: {
      title: next.title,
      description: next.description ?? '',
      state: next.state ?? 'new',
      priority: next.priority ?? 'sand',
      parent_task_id: next.parent_task_id ?? null,
      board_group_id: next.board_group_id ?? null,
      scheduled_for: next.scheduled_for ?? null,
      tags: next.tags ?? '',
      shares: next.shares ?? [],
      record_state: next.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: task.record_id,
    owner_npub: task.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'task'),
    version: (task.version ?? 1) + 1,
    previous_version: task.version ?? 1,
    signature_npub: session.npub,
    write_group_npub: selectWriteGroup(session, next, next.board_group_id),
    owner_payload: encryptOwnerPayload(task.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session),
  };
}

export function outboundComment(appNpub, session, target, {
  recordId,
  body,
  parentCommentId = null,
  anchorLineNumber = null,
  attachments = [],
  commentStatus = 'open',
  recordState = 'active',
  version = 1,
  previousVersion = 0,
}) {
  const targetFamilyHash = target.content != null
    ? recordFamilyHash(appNpub, 'document')
    : recordFamilyHash(appNpub, 'task');
  const payload = {
    app_namespace: appNpub,
    collection_space: 'comment',
    schema_version: 1,
    record_id: recordId,
    data: {
      target_record_id: target.record_id,
      target_record_family_hash: targetFamilyHash,
      parent_comment_id: parentCommentId,
      anchor_line_number: anchorLineNumber,
      comment_status: commentStatus,
      body,
      attachments,
      record_state: recordState,
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: recordId,
    owner_npub: target.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'comment'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_npub: selectWriteGroup(session, target, target.board_group_id),
    owner_payload: encryptOwnerPayload(target.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(target.group_ids || [], plaintext, session),
  };
}

export function outboundDocument(appNpub, session, document, patch = {}) {
  const next = { ...document, ...patch };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'document',
    schema_version: 1,
    record_id: document.record_id,
    data: {
      title: next.title ?? document.title ?? 'Untitled document',
      content: next.content ?? document.content ?? '',
      parent_directory_id: next.parent_directory_id ?? document.parent_directory_id ?? null,
      shares: next.shares ?? document.shares ?? [],
      record_state: next.record_state ?? document.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: document.record_id,
    owner_npub: document.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'document'),
    version: (document.version ?? 1) + 1,
    previous_version: document.version ?? 1,
    signature_npub: session.npub,
    write_group_npub: selectWriteGroup(session, next),
    owner_payload: encryptOwnerPayload(document.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session),
  };
}

export function outboundAudioNote(appNpub, session, {
  recordId,
  ownerNpub,
  targetRecordId = null,
  targetRecordFamilyHash = null,
  title = 'Voice note',
  storageObjectId,
  mimeType = 'audio/webm;codecs=opus',
  durationSeconds = null,
  sizeBytes = 0,
  mediaEncryption = null,
  waveformPreview = [],
  transcriptStatus = 'pending',
  transcriptPreview = null,
  transcript = null,
  summary = null,
  targetGroupIds = [],
  version = 1,
  previousVersion = 0,
  writeGroupNpub = null,
  recordState = 'active',
}) {
  const payload = {
    app_namespace: appNpub,
    collection_space: 'audio_note',
    schema_version: 1,
    record_id: recordId,
    data: {
      target_record_id: targetRecordId,
      target_record_family_hash: targetRecordFamilyHash,
      title,
      storage_object_id: storageObjectId,
      mime_type: mimeType,
      duration_seconds: durationSeconds,
      size_bytes: sizeBytes,
      media_encryption: mediaEncryption,
      waveform_preview: waveformPreview,
      transcript_status: transcriptStatus,
      transcript_preview: transcriptPreview,
      transcript,
      summary,
      record_state: recordState,
    },
  };
  const plaintext = JSON.stringify(payload);
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    record_family_hash: recordFamilyHash(appNpub, 'audio_note'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_npub: writeGroupNpub || selectWriteGroup(session, { group_ids: targetGroupIds }),
    owner_payload: encryptOwnerPayload(ownerNpub, plaintext, session),
    group_payloads: buildGroupPayloads(targetGroupIds || [], plaintext, session),
  };
}
