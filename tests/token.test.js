import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionToken } from '../src/token.js';

function makeToken(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

test('parseConnectionToken accepts raw connection token', () => {
  const token = makeToken({
    type: 'superbased_connection',
    version: 2,
    direct_https_url: 'https://sb4.otherstuff.studio',
    service_npub: 'npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v',
    workspace_owner_npub: 'npub1yfpzawrl752mylns20yyf9nurkfu3ftpnratakfxslumw0muh44q3h5x88',
    app_npub: 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5',
  });
  const parsed = parseConnectionToken(token);
  assert.equal(parsed.directHttpsUrl, 'https://sb4.otherstuff.studio');
  assert.equal(parsed.workspaceOwnerNpub, 'npub1yfpzawrl752mylns20yyf9nurkfu3ftpnratakfxslumw0muh44q3h5x88');
  assert.equal(parsed.appNpub, 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5');
});

test('parseConnectionToken extracts connection token from full agent connect package', () => {
  const connectionToken = makeToken({
    type: 'superbased_connection',
    version: 2,
    direct_https_url: 'https://sb4.otherstuff.studio',
    workspace_owner_npub: 'npub1yfpzawrl752mylns20yyf9nurkfu3ftpnratakfxslumw0muh44q3h5x88',
    app_npub: 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5',
  });
  const parsed = parseConnectionToken(JSON.stringify({
    kind: 'coworker_agent_connect',
    version: 4,
    connection_token: connectionToken,
  }));
  assert.equal(parsed.directHttpsUrl, 'https://sb4.otherstuff.studio');
});
