import Database from 'better-sqlite3';
import { ensureStateDir, getDbPath } from './config.js';

export function openDb() {
  ensureStateDir();
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups_cache (
      group_npub TEXT PRIMARY KEY,
      group_id TEXT,
      owner_npub TEXT,
      name TEXT,
      group_kind TEXT,
      private_member_npub TEXT,
      member_npubs_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_keys_cache (
      group_npub TEXT PRIMARY KEY,
      group_id TEXT,
      key_version INTEGER,
      wrapped_group_nsec TEXT NOT NULL,
      wrapped_by_npub TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
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
      parent_task_id TEXT,
      board_group_id TEXT,
      scheduled_for TEXT,
      tags TEXT,
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
      group_ids_json TEXT NOT NULL,
      shares_json TEXT NOT NULL,
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
      record_state TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'audio_notes', 'size_bytes', 'INTEGER');
  ensureColumn(db, 'audio_notes', 'media_encryption_json', 'TEXT');
  ensureColumn(db, 'audio_notes', 'waveform_preview_json', 'TEXT');
  ensureColumn(db, 'audio_notes', 'sender_npub', 'TEXT');
  return db;
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
      INSERT INTO groups_cache (group_npub, group_id, owner_npub, name, group_kind, private_member_npub, member_npubs_json, raw_json, synced_at)
      VALUES (@group_npub, @group_id, @owner_npub, @name, @group_kind, @private_member_npub, @member_npubs_json, @raw_json, @synced_at)
    `);
    for (const row of rows) stmt.run(row);
  });
  tx(groups);
}

export function replaceGroupKeys(db, keys) {
  const tx = db.transaction((rows) => {
    db.prepare(`DELETE FROM group_keys_cache`).run();
    const stmt = db.prepare(`
      INSERT INTO group_keys_cache (group_npub, group_id, key_version, wrapped_group_nsec, wrapped_by_npub, raw_json, synced_at)
      VALUES (@group_npub, @group_id, @key_version, @wrapped_group_nsec, @wrapped_by_npub, @raw_json, @synced_at)
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
