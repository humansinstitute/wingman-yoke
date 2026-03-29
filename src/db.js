import Database from 'better-sqlite3';
import { ensureStateDir, getDbPath } from './config.js';

export function openDb() {
  ensureStateDir();
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  migrateGroupCacheTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channels (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      group_ids_json TEXT NOT NULL,
      participant_npubs_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_message_id TEXT,
      body TEXT,
      attachments_json TEXT NOT NULL,
      sender_npub TEXT,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      description TEXT,
      state TEXT,
      priority TEXT,
      assigned_to_npub TEXT,
      parent_task_id TEXT,
      board_group_id TEXT,
      scheduled_for TEXT,
      tags TEXT,
      scope_id TEXT,
      scope_product_id TEXT,
      scope_project_id TEXT,
      scope_deliverable_id TEXT,
      group_ids_json TEXT NOT NULL,
      shares_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      target_record_id TEXT NOT NULL,
      target_record_family_hash TEXT,
      parent_comment_id TEXT,
      anchor_line_number INTEGER,
      comment_status TEXT,
      body TEXT,
      attachments_json TEXT NOT NULL,
      sender_npub TEXT,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      content TEXT,
      parent_directory_id TEXT,
      scope_id TEXT,
      scope_product_id TEXT,
      scope_project_id TEXT,
      scope_deliverable_id TEXT,
      group_ids_json TEXT NOT NULL,
      shares_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS directories (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      parent_directory_id TEXT,
      scope_id TEXT,
      scope_product_id TEXT,
      scope_project_id TEXT,
      scope_deliverable_id TEXT,
      group_ids_json TEXT NOT NULL,
      shares_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      declaration_type TEXT,
      surface TEXT,
      generated_at TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      scope_id TEXT,
      scope_level TEXT,
      scope_product_id TEXT,
      scope_project_id TEXT,
      scope_deliverable_id TEXT,
      group_ids_json TEXT NOT NULL DEFAULT '[]',
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio_notes (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      target_record_id TEXT,
      target_record_family_hash TEXT,
      title TEXT,
      storage_object_id TEXT,
      mime_type TEXT,
      duration_seconds REAL,
      size_bytes INTEGER,
      media_encryption_json TEXT,
      waveform_preview_json TEXT,
      transcript_status TEXT,
      transcript_preview TEXT,
      transcript TEXT,
      summary TEXT,
      sender_npub TEXT,
      group_ids_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scopes (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      level TEXT,
      title TEXT,
      description TEXT,
      parent_id TEXT,
      product_id TEXT,
      project_id TEXT,
      l1_id TEXT,
      l2_id TEXT,
      l3_id TEXT,
      l4_id TEXT,
      l5_id TEXT,
      group_ids_json TEXT NOT NULL DEFAULT '[]',
      shares_json TEXT NOT NULL DEFAULT '[]',
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      record_id TEXT PRIMARY KEY,
      owner_npub TEXT NOT NULL,
      title TEXT,
      description TEXT,
      time_start TEXT,
      time_end TEXT,
      days_json TEXT NOT NULL,
      timezone TEXT,
      assigned_group_id TEXT,
      active INTEGER,
      last_run TEXT,
      repeat TEXT,
      group_ids_json TEXT NOT NULL,
      shares_json TEXT NOT NULL,
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups_cache (
      group_id TEXT PRIMARY KEY,
      current_group_npub TEXT,
      current_epoch INTEGER NOT NULL DEFAULT 1,
      owner_npub TEXT,
      name TEXT,
      group_kind TEXT,
      private_member_npub TEXT,
      member_npubs_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_groups_cache_current_group_npub
      ON groups_cache(current_group_npub);
    CREATE TABLE IF NOT EXISTS group_keys_cache (
      group_id TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      group_npub TEXT NOT NULL,
      wrapped_group_nsec TEXT NOT NULL,
      wrapped_by_npub TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (group_id, key_version)
    );
    CREATE INDEX IF NOT EXISTS idx_group_keys_cache_group_npub
      ON group_keys_cache(group_npub);
  `);
  ensureColumn(db, 'groups_cache', 'current_group_npub', 'TEXT');
  ensureColumn(db, 'groups_cache', 'current_epoch', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'group_keys_cache', 'group_npub', 'TEXT');
  ensureColumn(db, 'tasks', 'references_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'tasks', 'assigned_to_npub', 'TEXT');
  ensureColumn(db, 'tasks', 'scope_id', 'TEXT');
  ensureColumn(db, 'tasks', 'scope_product_id', 'TEXT');
  ensureColumn(db, 'tasks', 'scope_project_id', 'TEXT');
  ensureColumn(db, 'tasks', 'scope_deliverable_id', 'TEXT');
  ensureColumn(db, 'documents', 'scope_id', 'TEXT');
  ensureColumn(db, 'documents', 'scope_product_id', 'TEXT');
  ensureColumn(db, 'documents', 'scope_project_id', 'TEXT');
  ensureColumn(db, 'documents', 'scope_deliverable_id', 'TEXT');
  ensureColumn(db, 'directories', 'scope_id', 'TEXT');
  ensureColumn(db, 'directories', 'scope_product_id', 'TEXT');
  ensureColumn(db, 'directories', 'scope_project_id', 'TEXT');
  ensureColumn(db, 'directories', 'scope_deliverable_id', 'TEXT');
  ensureColumn(db, 'reports', 'title', 'TEXT');
  ensureColumn(db, 'reports', 'declaration_type', 'TEXT');
  ensureColumn(db, 'reports', 'surface', 'TEXT');
  ensureColumn(db, 'reports', 'generated_at', 'TEXT');
  ensureColumn(db, 'reports', 'payload_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'reports', 'scope_id', 'TEXT');
  ensureColumn(db, 'reports', 'scope_level', 'TEXT');
  ensureColumn(db, 'reports', 'scope_product_id', 'TEXT');
  ensureColumn(db, 'reports', 'scope_project_id', 'TEXT');
  ensureColumn(db, 'reports', 'scope_deliverable_id', 'TEXT');
  ensureColumn(db, 'reports', 'group_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'scopes', 'group_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'scopes', 'shares_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'schedules', 'assigned_group_id', 'TEXT');
  ensureColumn(db, 'audio_notes', 'size_bytes', 'INTEGER');
  ensureColumn(db, 'audio_notes', 'media_encryption_json', 'TEXT');
  ensureColumn(db, 'audio_notes', 'waveform_preview_json', 'TEXT');
  ensureColumn(db, 'audio_notes', 'sender_npub', 'TEXT');
  // Scope hierarchy l1-l5 columns (leave old product_id/project_id/scope_*_id inert)
  ensureColumn(db, 'scopes', 'l1_id', 'TEXT');
  ensureColumn(db, 'scopes', 'l2_id', 'TEXT');
  ensureColumn(db, 'scopes', 'l3_id', 'TEXT');
  ensureColumn(db, 'scopes', 'l4_id', 'TEXT');
  ensureColumn(db, 'scopes', 'l5_id', 'TEXT');
  for (const table of ['tasks', 'documents', 'directories', 'reports']) {
    for (let i = 1; i <= 5; i++) {
      ensureColumn(db, table, `scope_l${i}_id`, 'TEXT');
    }
  }
  return db;
}

function tableExists(db, tableName) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
  return Boolean(row);
}

function tableInfo(db, tableName) {
  if (!tableExists(db, tableName)) return [];
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function primaryKeyColumns(columns) {
  return columns
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
}

function isLegacyGroupsCache(columns) {
  if (!columns.length) return false;
  const pk = primaryKeyColumns(columns);
  return pk.length !== 1 || pk[0] !== 'group_id' || !columns.some((column) => column.name === 'current_group_npub');
}

function isLegacyGroupKeysCache(columns) {
  if (!columns.length) return false;
  const pk = primaryKeyColumns(columns);
  if (pk.length !== 2 || pk[0] !== 'group_id' || pk[1] !== 'key_version') return true;
  return !columns.some((column) => column.name === 'group_npub');
}

function migrateGroupCacheTables(db) {
  const groupsColumns = tableInfo(db, 'groups_cache');
  if (isLegacyGroupsCache(groupsColumns)) {
    if (tableExists(db, 'groups_cache_legacy')) db.exec(`DROP TABLE groups_cache_legacy`);
    db.exec(`ALTER TABLE groups_cache RENAME TO groups_cache_legacy`);
  }

  const groupKeysColumns = tableInfo(db, 'group_keys_cache');
  if (isLegacyGroupKeysCache(groupKeysColumns)) {
    if (tableExists(db, 'group_keys_cache_legacy')) db.exec(`DROP TABLE group_keys_cache_legacy`);
    db.exec(`ALTER TABLE group_keys_cache RENAME TO group_keys_cache_legacy`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups_cache (
      group_id TEXT PRIMARY KEY,
      current_group_npub TEXT,
      current_epoch INTEGER NOT NULL DEFAULT 1,
      owner_npub TEXT,
      name TEXT,
      group_kind TEXT,
      private_member_npub TEXT,
      member_npubs_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_groups_cache_current_group_npub
      ON groups_cache(current_group_npub);
    CREATE TABLE IF NOT EXISTS group_keys_cache (
      group_id TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      group_npub TEXT NOT NULL,
      wrapped_group_nsec TEXT NOT NULL,
      wrapped_by_npub TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (group_id, key_version)
    );
    CREATE INDEX IF NOT EXISTS idx_group_keys_cache_group_npub
      ON group_keys_cache(group_npub);
  `);

  if (tableExists(db, 'groups_cache_legacy')) {
    const rows = db.prepare(`SELECT * FROM groups_cache_legacy`).all();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO groups_cache (
        group_id,
        current_group_npub,
        current_epoch,
        owner_npub,
        name,
        group_kind,
        private_member_npub,
        member_npubs_json,
        raw_json,
        synced_at
      ) VALUES (
        @group_id,
        @current_group_npub,
        @current_epoch,
        @owner_npub,
        @name,
        @group_kind,
        @private_member_npub,
        @member_npubs_json,
        @raw_json,
        @synced_at
      )
    `);
    for (const row of rows) {
      stmt.run({
        group_id: row.group_id || row.group_npub,
        current_group_npub: row.current_group_npub || row.group_npub || null,
        current_epoch: Number.isInteger(row.current_epoch) ? row.current_epoch : 1,
        owner_npub: row.owner_npub ?? null,
        name: row.name ?? '',
        group_kind: row.group_kind ?? null,
        private_member_npub: row.private_member_npub ?? null,
        member_npubs_json: row.member_npubs_json ?? '[]',
        raw_json: row.raw_json ?? '{}',
        synced_at: row.synced_at ?? new Date().toISOString(),
      });
    }
    db.exec(`DROP TABLE groups_cache_legacy`);
  }

  if (tableExists(db, 'group_keys_cache_legacy')) {
    const rows = db.prepare(`SELECT * FROM group_keys_cache_legacy`).all();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO group_keys_cache (
        group_id,
        key_version,
        group_npub,
        wrapped_group_nsec,
        wrapped_by_npub,
        raw_json,
        synced_at
      ) VALUES (
        @group_id,
        @key_version,
        @group_npub,
        @wrapped_group_nsec,
        @wrapped_by_npub,
        @raw_json,
        @synced_at
      )
    `);
    for (const row of rows) {
      stmt.run({
        group_id: row.group_id || row.group_npub,
        key_version: Number.isInteger(row.key_version) ? row.key_version : 1,
        group_npub: row.group_npub,
        wrapped_group_nsec: row.wrapped_group_nsec,
        wrapped_by_npub: row.wrapped_by_npub,
        raw_json: row.raw_json ?? '{}',
        synced_at: row.synced_at ?? new Date().toISOString(),
      });
    }
    db.exec(`DROP TABLE group_keys_cache_legacy`);
  }
}

function ensureColumn(db, tableName, columnName, typeSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeSql}`);
}

export function putMeta(db, key, value) {
  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

export function getMeta(db, key) {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key);
  return row?.value ?? null;
}

export function replaceGroups(db, groups) {
  const tx = db.transaction((rows) => {
    db.prepare(`DELETE FROM groups_cache`).run();
    const stmt = db.prepare(`
      INSERT INTO groups_cache (group_id, current_group_npub, current_epoch, owner_npub, name, group_kind, private_member_npub, member_npubs_json, raw_json, synced_at)
      VALUES (@group_id, @current_group_npub, @current_epoch, @owner_npub, @name, @group_kind, @private_member_npub, @member_npubs_json, @raw_json, @synced_at)
    `);
    for (const row of rows) stmt.run(row);
  });
  tx(groups);
}

export function replaceGroupKeys(db, keys) {
  const tx = db.transaction((rows) => {
    db.prepare(`DELETE FROM group_keys_cache`).run();
    const stmt = db.prepare(`
      INSERT INTO group_keys_cache (group_id, key_version, group_npub, wrapped_group_nsec, wrapped_by_npub, raw_json, synced_at)
      VALUES (@group_id, @key_version, @group_npub, @wrapped_group_nsec, @wrapped_by_npub, @raw_json, @synced_at)
    `);
    for (const row of rows) stmt.run(row);
  });
  tx(keys);
}

export function upsertRows(db, tableName, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  const updates = columns.filter((column) => column !== 'record_id' && column !== 'group_npub')
    .map((column) => `${column}=excluded.${column}`)
    .join(', ');
  const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${columns[0]}) DO UPDATE SET ${updates}`;
  const stmt = db.prepare(sql);
  const tx = db.transaction((items) => {
    for (const item of items) stmt.run(item);
  });
  tx(rows);
}

export function getRows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function getRow(db, sql, params = []) {
  return db.prepare(sql).get(...params) ?? null;
}
