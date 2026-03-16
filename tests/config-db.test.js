import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('config and db honor WINGMAN_AP_STATE_DIR override', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-ap-state-'));
  process.env.WINGMAN_AP_STATE_DIR = dir;
  const { saveConfig, loadConfig, getDbPath } = await import(`../src/config.js?state=${Date.now()}`);
  const { openDb, putMeta, getMeta } = await import(`../src/db.js?state=${Date.now()}`);
  saveConfig({ version: 1, token: 'abc', directHttpsUrl: 'https://example.com' });
  const config = loadConfig();
  assert.equal(config.directHttpsUrl, 'https://example.com');
  assert.ok(getDbPath().startsWith(dir));
  const db = openDb();
  putMeta(db, 'hello', 'world');
  assert.equal(getMeta(db, 'hello'), 'world');
  db.close();
  delete process.env.WINGMAN_AP_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});
