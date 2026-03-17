import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseConnectionToken } from './token.js';

function getDefaultStateDir() {
  return path.join(os.homedir(), '.wingman-yoke');
}

function getLegacyStateDir() {
  return path.join(os.homedir(), '.wingman-ap');
}

export function getStateDir() {
  const override = String(process.env.WINGMAN_YOKE_STATE_DIR || '').trim();
  if (override) return override;
  const legacyOverride = String(process.env.WINGMAN_AP_STATE_DIR || '').trim();
  if (legacyOverride) return legacyOverride;
  const defaultDir = getDefaultStateDir();
  if (fs.existsSync(defaultDir)) return defaultDir;
  const legacyDir = getLegacyStateDir();
  if (fs.existsSync(legacyDir)) return legacyDir;
  return defaultDir;
}

export function getConfigPath() {
  return path.join(getStateDir(), 'config.json');
}

export function getDbPath() {
  const stateDir = getStateDir();
  const preferredPath = path.join(stateDir, 'yoke.db');
  if (fs.existsSync(preferredPath)) return preferredPath;
  const legacyPath = path.join(stateDir, 'autopilot.db');
  if (fs.existsSync(legacyPath)) return legacyPath;
  return preferredPath;
}

export function ensureStateDir() {
  fs.mkdirSync(getStateDir(), { recursive: true });
}

function withConfigDb(fn) {
  ensureStateDir();
  const db = new Database(getDbPath());
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function loadConfigFromDb() {
  return withConfigDb((db) => {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'config:current'`).get();
    return row?.value ? JSON.parse(row.value) : null;
  });
}

function saveConfigToDb(nextConfig) {
  withConfigDb((db) => {
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES ('config:current', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(nextConfig));
  });
}

export function loadConfig() {
  ensureStateDir();
  const dbConfig = loadConfigFromDb();
  if (dbConfig) return dbConfig;
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function saveConfig(nextConfig) {
  ensureStateDir();
  saveConfigToDb(nextConfig);
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
}

export function initConfigFromToken(rawToken) {
  const parsed = parseConnectionToken(rawToken);
  const config = {
    version: 1,
    token: parsed.rawToken,
    directHttpsUrl: parsed.directHttpsUrl,
    serviceNpub: parsed.serviceNpub,
    workspaceOwnerNpub: parsed.workspaceOwnerNpub,
    workspaceOwnerPubkey: parsed.workspaceOwnerPubkey,
    appNpub: parsed.appNpub,
    appPubkey: parsed.appPubkey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveConfig(config);
  return config;
}
