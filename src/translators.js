import { decryptFromNpub, encryptForNpub } from './nostr.js';

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

function normalizeGroupRef(value) {
  const ref = String(value || '').trim();
  return ref || null;
}

function normalizeKeyVersion(value) {
  return Number.isInteger(value) ? value : null;
}

function resolveAccessibleGroupEntry(groupKeys, groupRef, options = {}) {
  const ref = normalizeGroupRef(groupRef);
  if (!ref) return null;
  const keyVersion = normalizeKeyVersion(options.keyVersion);
  const entry = groupKeys.get(ref, keyVersion != null ? { keyVersion } : {});
  if (!entry?.groupNpub) return null;
  return entry;
}

function latestKeyEntry(keyring) {
  let latest = null;
  for (const entry of keyring.values()) {
    if (!latest || (entry.keyVersion ?? 0) > (latest.keyVersion ?? 0)) latest = entry;
  }
  return latest;
}

function resolveGroupPayloadId(payload) {
  return normalizeGroupRef(payload?.group_id) || normalizeGroupRef(payload?.group_npub);
}

function collectGroupIds(groupPayloads = []) {
  return [...new Set(groupPayloads.map((payload) => resolveGroupPayloadId(payload)).filter(Boolean))];
}

function normalizeShares(dataShares = [], groupPayloads = []) {
  if (Array.isArray(dataShares) && dataShares.length > 0) {
    return dataShares.map((share) => ({
      type: share.type === 'person' ? 'person' : 'group',
      key: share.type === 'person'
        ? (share.key ?? share.person_npub)
        : (share.group_id ?? share.group_npub),
      access: share.access === 'write' ? 'write' : 'read',
      label: share.label ?? '',
      person_npub: share.person_npub ?? null,
      group_id: share.group_id ?? share.group_npub ?? null,
      group_npub: share.group_npub ?? null,
      via_group_id: share.via_group_id ?? share.via_group_npub ?? null,
      via_group_npub: share.via_group_npub ?? null,
      inherited: share.inherited === true,
      inherited_from_directory_id: share.inherited_from_directory_id ?? null,
    }));
  }

  return groupPayloads.map((payload) => ({
    type: 'group',
    key: payload.group_id ?? payload.group_npub,
    access: payload.write ? 'write' : 'read',
    label: '',
    person_npub: null,
    group_id: payload.group_id ?? payload.group_npub ?? null,
    group_epoch: payload.group_epoch ?? null,
    group_npub: payload.group_npub,
    via_group_id: null,
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
    groupId: keyRow.group_id ?? keyRow.group_npub,
    groupNpub: keyRow.group_npub,
    keyVersion: keyRow.key_version ?? keyRow.epoch ?? 1,
    nsec,
    secret: session.constructor?.decodeNsec ? session.constructor.decodeNsec(nsec) : null,
  };
}

export function loadGroupKeyMap(session, keyRows, decodeNsec) {
  const byId = new Map();
  const byNpub = new Map();
  for (const row of keyRows) {
    const nsec = decryptFromNpub(session.secret, row.wrapped_by_npub, row.wrapped_group_nsec);
    const entry = {
      groupNpub: row.group_npub,
      groupId: row.group_id ?? row.group_npub,
      keyVersion: row.key_version ?? row.epoch ?? 1,
      nsec,
      secret: decodeNsec(nsec),
    };
    byNpub.set(entry.groupNpub, entry);
    const keyring = byId.get(entry.groupId) ?? new Map();
    keyring.set(entry.keyVersion, entry);
    byId.set(entry.groupId, keyring);
  }

  const get = (groupRef, options = {}) => {
    const ref = normalizeGroupRef(groupRef);
    if (!ref) return null;
    const keyVersion = normalizeKeyVersion(options.keyVersion);
    const keyring = byId.get(ref);
    if (keyring?.size) {
      if (keyVersion != null && keyring.has(keyVersion)) return keyring.get(keyVersion) ?? null;
      return latestKeyEntry(keyring);
    }
    return byNpub.get(ref) ?? null;
  };

  return {
    byId,
    byNpub,
    get,
    getCurrent(groupRef) {
      return get(groupRef);
    },
    has(groupRef, options = {}) {
      return Boolean(get(groupRef, options));
    },
    resolveGroupId(groupRef) {
      return get(groupRef)?.groupId ?? normalizeGroupRef(groupRef);
    },
    resolveGroupNpub(groupRef) {
      const ref = normalizeGroupRef(groupRef);
      if (!ref) return null;
      return get(groupRef)?.groupNpub ?? (byNpub.has(ref) ? ref : null);
    },
  };
}

export function decryptRecordPayload(record, session, groupKeys) {
  const ownerCiphertext = record.owner_payload?.ciphertext ?? record.owner_payload;
  if (ownerCiphertext && record.owner_npub === session.npub) {
    return parsePayloadJson(decryptFromNpub(session.secret, record.signature_npub || record.owner_npub, ownerCiphertext));
  }

  for (const payload of (record.group_payloads || [])) {
    const keyVersion = normalizeKeyVersion(payload.group_epoch);
    const keyEntry = groupKeys.get(payload.group_id, { keyVersion })
      || groupKeys.get(payload.group_npub);
    if (!keyEntry?.secret) continue;
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

function normalizeReportDeclarationType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (['metric', 'timeseries', 'table', 'text'].includes(type)) return type;
  return 'text';
}

function normalizeReportPayloadObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload;
}

const LEGACY_LEVEL_MAP = { product: 'l1', project: 'l2', deliverable: 'l3' };

export function normalizeScopeLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  if (!value) return null;
  if (LEGACY_LEVEL_MAP[value]) return LEGACY_LEVEL_MAP[value];
  if (/^l[1-5]$/.test(value)) return value;
  return null;
}

export function scopeDepth(level) {
  const normalized = normalizeScopeLevel(level);
  if (!normalized) return null;
  return Number(normalized.charAt(1));
}

export function computeScopeLineage(selfId, level, parent) {
  const result = {
    level,
    parent_id: parent?.record_id ?? null,
    l1_id: null,
    l2_id: null,
    l3_id: null,
    l4_id: null,
    l5_id: null,
  };
  if (parent) {
    for (let i = 1; i <= 5; i++) result[`l${i}_id`] = parent[`l${i}_id`] ?? null;
  }
  const depth = scopeDepth(level);
  if (depth) result[`l${depth}_id`] = selfId;
  return result;
}

export function buildScopeTags(scope) {
  if (!scope) {
    return { scope_id: null, scope_l1_id: null, scope_l2_id: null, scope_l3_id: null, scope_l4_id: null, scope_l5_id: null };
  }
  return {
    scope_id: scope.record_id ?? null,
    scope_l1_id: scope.l1_id ?? null,
    scope_l2_id: scope.l2_id ?? null,
    scope_l3_id: scope.l3_id ?? null,
    scope_l4_id: scope.l4_id ?? null,
    scope_l5_id: scope.l5_id ?? null,
  };
}

function normalizeScopedRecordLineage(data) {
  if (data.scope_l1_id !== undefined || data.scope_l2_id !== undefined) {
    return {
      scope_l1_id: data.scope_l1_id ?? null,
      scope_l2_id: data.scope_l2_id ?? null,
      scope_l3_id: data.scope_l3_id ?? null,
      scope_l4_id: data.scope_l4_id ?? null,
      scope_l5_id: data.scope_l5_id ?? null,
    };
  }
  return {
    scope_l1_id: data.scope_product_id ?? null,
    scope_l2_id: data.scope_project_id ?? null,
    scope_l3_id: data.scope_deliverable_id ?? null,
    scope_l4_id: null,
    scope_l5_id: null,
  };
}

function normalizeScopeRecordLineage(data, selfId) {
  if (data.l1_id !== undefined || data.l2_id !== undefined) {
    return {
      l1_id: data.l1_id ?? null,
      l2_id: data.l2_id ?? null,
      l3_id: data.l3_id ?? null,
      l4_id: data.l4_id ?? null,
      l5_id: data.l5_id ?? null,
    };
  }
  const normalized = normalizeScopeLevel(data.level);
  if (normalized === 'l1') {
    return { l1_id: selfId, l2_id: null, l3_id: null, l4_id: null, l5_id: null };
  }
  if (normalized === 'l2') {
    return { l1_id: data.product_id ?? null, l2_id: selfId, l3_id: null, l4_id: null, l5_id: null };
  }
  if (normalized === 'l3') {
    return { l1_id: data.product_id ?? null, l2_id: data.project_id ?? null, l3_id: selfId, l4_id: null, l5_id: null };
  }
  return { l1_id: null, l2_id: null, l3_id: null, l4_id: null, l5_id: null };
}

function normalizeReportScope(scope = {}) {
  const nextScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  const level = normalizeScopeLevel(nextScope.level ?? nextScope.scope_level) ?? null;
  if (nextScope.l1_id !== undefined || nextScope.l2_id !== undefined) {
    return {
      id: nextScope.id ?? nextScope.scope_id ?? null,
      level,
      l1_id: nextScope.l1_id ?? null,
      l2_id: nextScope.l2_id ?? null,
      l3_id: nextScope.l3_id ?? null,
      l4_id: nextScope.l4_id ?? null,
      l5_id: nextScope.l5_id ?? null,
    };
  }
  return {
    id: nextScope.id ?? nextScope.scope_id ?? null,
    level,
    l1_id: nextScope.product_id ?? nextScope.scope_product_id ?? null,
    l2_id: nextScope.project_id ?? nextScope.scope_project_id ?? null,
    l3_id: nextScope.deliverable_id ?? nextScope.scope_deliverable_id ?? null,
    l4_id: null,
    l5_id: null,
  };
}

function normalizeReportMetadata(metadata = {}, recordState = 'active') {
  const nextMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return {
    title: String(nextMetadata.title || '').trim(),
    generated_at: nextMetadata.generated_at ?? null,
    record_state: nextMetadata.record_state ?? recordState,
    surface: nextMetadata.surface ?? null,
    scope: normalizeReportScope(nextMetadata.scope),
  };
}

function reportScopeFromRecord(record = {}) {
  return normalizeReportScope({
    id: record.scope_id ?? null,
    level: record.scope_level ?? null,
    l1_id: record.scope_l1_id ?? null,
    l2_id: record.scope_l2_id ?? null,
    l3_id: record.scope_l3_id ?? null,
    l4_id: record.scope_l4_id ?? null,
    l5_id: record.scope_l5_id ?? null,
  });
}

export function inboundGroup(group) {
  const currentGroupNpub = group.current_group_npub ?? group.group_npub ?? group.id;
  return {
    group_npub: currentGroupNpub,
    current_group_npub: currentGroupNpub,
    group_id: group.id ?? group.group_id ?? group.group_npub,
    current_epoch: Number(group.current_epoch || 1),
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
    group_ids: collectGroupIds(record.group_payloads || []),
    participant_npubs: Array.isArray(data.participant_npubs) ? data.participant_npubs : [record.owner_npub],
    scope_id: data.scope_id ?? null,
    ...normalizeScopedRecordLineage(data),
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
    assigned_to_npub: data.assigned_to_npub ?? null,
    parent_task_id: data.parent_task_id ?? null,
    board_group_id: data.board_group_id ?? null,
    scheduled_for: data.scheduled_for ?? null,
    tags: data.tags ?? '',
    scope_id: data.scope_id ?? null,
    ...normalizeScopedRecordLineage(data),
    references: Array.isArray(data.references) ? data.references : [],
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: collectGroupIds(record.group_payloads || []),
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
    scope_id: data.scope_id ?? null,
    ...normalizeScopedRecordLineage(data),
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: collectGroupIds(record.group_payloads || []),
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
    scope_id: data.scope_id ?? null,
    ...normalizeScopedRecordLineage(data),
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: collectGroupIds(record.group_payloads || []),
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
    group_ids: collectGroupIds(record.group_payloads || []),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundScope(record, payload) {
  const data = payload.data ?? payload;
  const level = normalizeScopeLevel(data.level) ?? data.level ?? null;
  const lineage = normalizeScopeRecordLineage(data, record.record_id);
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    level,
    title: data.title ?? '',
    description: data.description ?? '',
    parent_id: data.parent_id ?? null,
    ...lineage,
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: collectGroupIds(record.group_payloads || []),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundSchedule(record, payload) {
  const data = payload.data ?? payload;
  const rawDays = data.days ?? data.days_json ?? [];
  const days = Array.isArray(rawDays) ? rawDays : (typeof rawDays === 'string' ? rawDays.split(',').map((d) => d.trim()).filter(Boolean) : []);
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: data.title ?? '',
    description: data.description ?? '',
    time_start: data.time_start ?? null,
    time_end: data.time_end ?? null,
    days,
    timezone: data.timezone ?? 'Australia/Perth',
    assigned_group_id: data.assigned_group_id ?? data.assigned_to_npub ?? null,
    active: data.active === true || data.active === 1,
    last_run: data.last_run ?? null,
    repeat: data.repeat ?? 'daily',
    shares: normalizeShares(data.shares, record.group_payloads || []),
    group_ids: collectGroupIds(record.group_payloads || []),
    record_state: normalizeRecordState(data),
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function inboundReport(record, payload) {
  const metadata = normalizeReportMetadata(payload.metadata, 'active');
  const declaration = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};
  return {
    record_id: record.record_id,
    owner_npub: record.owner_npub,
    title: metadata.title || '',
    surface: metadata.surface ?? null,
    generated_at: metadata.generated_at ?? record.updated_at ?? new Date().toISOString(),
    metadata,
    declaration_type: normalizeReportDeclarationType(declaration.declaration_type),
    payload: normalizeReportPayloadObject(declaration.payload),
    scope_id: metadata.scope.id ?? null,
    scope_level: metadata.scope.level ?? null,
    scope_l1_id: metadata.scope.l1_id ?? null,
    scope_l2_id: metadata.scope.l2_id ?? null,
    scope_l3_id: metadata.scope.l3_id ?? null,
    scope_l4_id: metadata.scope.l4_id ?? null,
    scope_l5_id: metadata.scope.l5_id ?? null,
    group_ids: collectGroupIds(record.group_payloads || []),
    record_state: metadata.record_state ?? 'active',
    version: record.version ?? 1,
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function outboundSchedule(appNpub, session, groupKeys, schedule, patch = {}) {
  const next = { ...schedule, ...patch };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'schedule',
    schema_version: 1,
    record_id: schedule.record_id,
    data: {
      title: next.title,
      description: next.description ?? '',
      time_start: next.time_start ?? null,
      time_end: next.time_end ?? null,
      days: Array.isArray(next.days) ? next.days : [],
      timezone: next.timezone ?? 'Australia/Perth',
      assigned_group_id: next.assigned_group_id ?? null,
      active: next.active === true || next.active === 1,
      last_run: next.last_run ?? null,
      repeat: next.repeat ?? 'daily',
      shares: next.shares ?? [],
      record_state: next.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    resolveWriteGroup(session, groupKeys, next, next.assigned_group_id ?? next.board_group_id)
  );
  return {
    record_id: schedule.record_id,
    owner_npub: schedule.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'schedule'),
    version: (schedule.version ?? 1) + 1,
    previous_version: schedule.version ?? 1,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(schedule.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundReport(appNpub, session, groupKeys, report, patch = {}) {
  const next = { ...report, ...patch };
  const metadata = normalizeReportMetadata({
    title: next.title ?? report.title ?? '',
    generated_at: next.generated_at ?? report.generated_at ?? null,
    surface: next.surface ?? report.surface ?? null,
    record_state: next.record_state ?? report.record_state ?? 'active',
    scope: reportScopeFromRecord(next),
  }, next.record_state ?? report.record_state ?? 'active');
  const data = {
    declaration_type: normalizeReportDeclarationType(next.declaration_type ?? report.declaration_type),
    payload: normalizeReportPayloadObject(next.payload ?? report.payload),
  };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'report',
    schema_version: 1,
    record_id: report.record_id,
    metadata,
    data,
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    next.write_group_id
      ?? next.write_group_npub
      ?? resolveWriteGroup(session, groupKeys, { group_ids: next.group_ids || [] }, next.group_ids?.[0] ?? null)
  );
  return {
    record_id: report.record_id,
    owner_npub: report.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'report'),
    version: (report.version ?? 0) + 1,
    previous_version: report.version ?? 0,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(report.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}

export function makeGroupWriteShare(groupRef, label = '') {
  const groupId = typeof groupRef === 'object'
    ? normalizeGroupRef(groupRef.group_id ?? groupRef.groupId ?? groupRef.id)
    : normalizeGroupRef(groupRef);
  const groupNpub = typeof groupRef === 'object'
    ? normalizeGroupRef(groupRef.current_group_npub ?? groupRef.group_npub ?? groupRef.groupNpub)
    : null;
  return {
    type: 'group',
    key: groupId || groupNpub,
    access: 'write',
    label,
    person_npub: null,
    group_id: groupId || groupNpub,
    group_npub: groupNpub,
    via_group_id: null,
    via_group_npub: null,
    inherited: false,
    inherited_from_directory_id: null,
  };
}

export function encryptOwnerPayload(ownerNpub, plaintext, session) {
  return { ciphertext: encryptForNpub(session.secret, ownerNpub, plaintext) };
}

function buildGroupPayloads(groupIds, plaintext, session, groupKeys, canWriteMap = null) {
  const uniqueGroups = new Map();
  const requestedRefs = [];
  for (const value of (groupIds || [])) {
    const ref = normalizeGroupRef(value);
    if (!ref) continue;
    requestedRefs.push(ref);
    const keyEntry = resolveAccessibleGroupEntry(groupKeys, ref);
    if (!keyEntry?.groupNpub) continue;
    const stableGroupId = keyEntry.groupId || ref;
    if (!uniqueGroups.has(stableGroupId)) uniqueGroups.set(stableGroupId, keyEntry);
  }

  if (uniqueGroups.size === 0 && requestedRefs.length > 0) {
    throw new Error(`No group key loaded for ${requestedRefs[0]}`);
  }

  return [...uniqueGroups.entries()].map(([stableGroupId, keyEntry]) => ({
    group_id: keyEntry.groupId || stableGroupId,
    group_epoch: keyEntry.keyVersion || undefined,
    group_npub: keyEntry.groupNpub,
    ciphertext: JSON.stringify({
      encrypted_by_npub: session.npub,
      ciphertext: encryptForNpub(session.secret, keyEntry.groupNpub, plaintext),
    }),
    write: canWriteMap instanceof Map
      ? (canWriteMap.get(stableGroupId) === true || canWriteMap.get(keyEntry.groupNpub) === true)
      : true,
  }));
}

function resolveWriteGroup(session, groupKeys, resource, fallbackGroupId = null) {
  const resolveGroupId = (groupRef) => resolveAccessibleGroupEntry(groupKeys, groupRef)?.groupId ?? null;
  const explicit = resolveGroupId(fallbackGroupId);
  if (explicit) return explicit;
  const shares = Array.isArray(resource?.shares) ? resource.shares : [];
  const directPersonShare = shares.find((share) => (
    share?.person_npub === session.npub
    && share?.access === 'write'
    && (
      normalizeGroupRef(share?.via_group_id)
      || normalizeGroupRef(share?.via_group_npub)
    )
    && resolveGroupId(share?.via_group_id ?? share?.via_group_npub)
  ));
  if (directPersonShare?.via_group_id || directPersonShare?.via_group_npub) {
    return resolveGroupId(directPersonShare.via_group_id ?? directPersonShare.via_group_npub);
  }
  const writableGroupShare = shares.find((share) => (
    normalizeGroupRef(share?.group_id ?? share?.group_npub)
    && share?.access === 'write'
    && resolveGroupId(share?.group_id ?? share?.group_npub)
  ));
  if (writableGroupShare?.group_id || writableGroupShare?.group_npub) {
    return resolveGroupId(writableGroupShare.group_id ?? writableGroupShare.group_npub);
  }
  for (const groupId of (resource?.group_ids || [])) {
    const resolved = resolveGroupId(groupId);
    if (resolved) return resolved;
  }
  return null;
}

function resolveWriteGroupMetadata(groupKeys, groupId) {
  const resolvedGroupId = groupKeys.resolveGroupId(groupId);
  if (!resolvedGroupId) return { groupId: null, groupNpub: null };
  return {
    groupId: resolvedGroupId,
    groupNpub: groupKeys.resolveGroupNpub(resolvedGroupId),
  };
}

export function outboundChatMessage(appNpub, session, groupKeys, channel, {
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
  const writeGroup = resolveWriteGroupMetadata(groupKeys, resolveWriteGroup(session, groupKeys, channel));
  return {
    record_id: recordId,
    owner_npub: channel.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'chat_message'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(channel.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(channel.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundChannel(appNpub, session, groupKeys, {
  recordId,
  ownerNpub,
  title,
  groupIds = [],
  participantNpubs = [],
  scopeId = null,
  scopeL1Id = null,
  scopeL2Id = null,
  scopeL3Id = null,
  scopeL4Id = null,
  scopeL5Id = null,
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
      scope_l1_id: scopeL1Id,
      scope_l2_id: scopeL2Id,
      scope_l3_id: scopeL3Id,
      scope_l4_id: scopeL4Id,
      scope_l5_id: scopeL5Id,
      record_state: recordState,
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    writeGroupNpub || resolveWriteGroup(session, groupKeys, { group_ids: groupIds })
  );
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    record_family_hash: recordFamilyHash(appNpub, 'channel'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(ownerNpub, plaintext, session),
    group_payloads: buildGroupPayloads(groupIds || [], plaintext, session, groupKeys),
  };
}

export function outboundTask(appNpub, session, groupKeys, task, patch = {}) {
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
      assigned_to_npub: next.assigned_to_npub ?? null,
      parent_task_id: next.parent_task_id ?? null,
      board_group_id: next.board_group_id ?? null,
      scheduled_for: next.scheduled_for ?? null,
      tags: next.tags ?? '',
      scope_id: next.scope_id ?? null,
      scope_l1_id: next.scope_l1_id ?? null,
      scope_l2_id: next.scope_l2_id ?? null,
      scope_l3_id: next.scope_l3_id ?? null,
      scope_l4_id: next.scope_l4_id ?? null,
      scope_l5_id: next.scope_l5_id ?? null,
      references: next.references ?? [],
      shares: next.shares ?? [],
      record_state: next.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    resolveWriteGroup(session, groupKeys, next, next.board_group_id)
  );
  return {
    record_id: task.record_id,
    owner_npub: task.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'task'),
    version: (task.version ?? 1) + 1,
    previous_version: task.version ?? 1,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(task.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundComment(appNpub, session, groupKeys, target, {
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
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    resolveWriteGroup(session, groupKeys, target, target.board_group_id)
  );
  return {
    record_id: recordId,
    owner_npub: target.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'comment'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(target.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(target.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundDocument(appNpub, session, groupKeys, document, patch = {}) {
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
      scope_id: next.scope_id ?? document.scope_id ?? null,
      scope_l1_id: next.scope_l1_id ?? document.scope_l1_id ?? null,
      scope_l2_id: next.scope_l2_id ?? document.scope_l2_id ?? null,
      scope_l3_id: next.scope_l3_id ?? document.scope_l3_id ?? null,
      scope_l4_id: next.scope_l4_id ?? document.scope_l4_id ?? null,
      scope_l5_id: next.scope_l5_id ?? document.scope_l5_id ?? null,
      shares: next.shares ?? document.shares ?? [],
      record_state: next.record_state ?? document.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(groupKeys, resolveWriteGroup(session, groupKeys, next));
  return {
    record_id: document.record_id,
    owner_npub: document.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'document'),
    version: (document.version ?? 1) + 1,
    previous_version: document.version ?? 1,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(document.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundAudioNote(appNpub, session, groupKeys, {
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
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    writeGroupNpub || resolveWriteGroup(session, groupKeys, { group_ids: targetGroupIds })
  );
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    record_family_hash: recordFamilyHash(appNpub, 'audio_note'),
    version,
    previous_version: previousVersion,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(ownerNpub, plaintext, session),
    group_payloads: buildGroupPayloads(targetGroupIds || [], plaintext, session, groupKeys),
  };
}

export function outboundDirectory(appNpub, session, groupKeys, directory, patch = {}) {
  const next = { ...directory, ...patch };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'directory',
    schema_version: 1,
    record_id: directory.record_id,
    data: {
      title: next.title ?? directory.title ?? 'Untitled directory',
      parent_directory_id: next.parent_directory_id ?? directory.parent_directory_id ?? null,
      scope_id: next.scope_id ?? directory.scope_id ?? null,
      scope_l1_id: next.scope_l1_id ?? directory.scope_l1_id ?? null,
      scope_l2_id: next.scope_l2_id ?? directory.scope_l2_id ?? null,
      scope_l3_id: next.scope_l3_id ?? directory.scope_l3_id ?? null,
      scope_l4_id: next.scope_l4_id ?? directory.scope_l4_id ?? null,
      scope_l5_id: next.scope_l5_id ?? directory.scope_l5_id ?? null,
      shares: next.shares ?? directory.shares ?? [],
      record_state: next.record_state ?? directory.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(groupKeys, resolveWriteGroup(session, groupKeys, next));
  return {
    record_id: directory.record_id,
    owner_npub: directory.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'directory'),
    version: (directory.version ?? 1) + 1,
    previous_version: directory.version ?? 1,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(directory.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}

export function outboundScope(appNpub, session, groupKeys, scope, patch = {}) {
  const next = { ...scope, ...patch };
  const payload = {
    app_namespace: appNpub,
    collection_space: 'scope',
    schema_version: 1,
    record_id: scope.record_id,
    data: {
      title: next.title ?? scope.title ?? '',
      description: next.description ?? scope.description ?? '',
      level: next.level ?? scope.level ?? 'l1',
      parent_id: next.parent_id ?? scope.parent_id ?? null,
      l1_id: next.l1_id ?? scope.l1_id ?? null,
      l2_id: next.l2_id ?? scope.l2_id ?? null,
      l3_id: next.l3_id ?? scope.l3_id ?? null,
      l4_id: next.l4_id ?? scope.l4_id ?? null,
      l5_id: next.l5_id ?? scope.l5_id ?? null,
      record_state: next.record_state ?? scope.record_state ?? 'active',
    },
  };
  const plaintext = JSON.stringify(payload);
  const writeGroup = resolveWriteGroupMetadata(
    groupKeys,
    resolveWriteGroup(session, groupKeys, next, next.group_ids?.[0] ?? null)
  );
  return {
    record_id: scope.record_id,
    owner_npub: scope.owner_npub,
    record_family_hash: recordFamilyHash(appNpub, 'scope'),
    version: (scope.version ?? 1) + 1,
    previous_version: scope.version ?? 1,
    signature_npub: session.npub,
    write_group_id: writeGroup.groupId || undefined,
    write_group_npub: writeGroup.groupNpub || undefined,
    owner_payload: encryptOwnerPayload(scope.owner_npub, plaintext, session),
    group_payloads: buildGroupPayloads(next.group_ids || [], plaintext, session, groupKeys),
  };
}
