import { Buffer } from 'node:buffer';
import { nip19 } from 'nostr-tools';

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(String(value || '').trim(), 'base64').toString('utf8'));
}

function normalizeRawTokenInput(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Connection token is required.');
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.connection_token === 'string' && parsed.connection_token.trim()) {
      return parsed.connection_token.trim();
    }
  }
  return raw;
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function decodeNpubToHex(npub) {
  if (!npub) return null;
  try {
    const decoded = nip19.decode(String(npub).trim());
    return decoded.type === 'npub' ? decoded.data : null;
  } catch {
    return null;
  }
}

export function parseConnectionToken(rawToken) {
  const parsed = decodeBase64Json(normalizeRawTokenInput(rawToken));
  if (parsed?.type !== 'superbased_connection') {
    throw new Error('Unsupported token type. Expected superbased_connection.');
  }

  const directHttpsUrl = firstString(parsed, [
    'direct_https_url',
    'backend_url',
    'url',
    'https',
    'http',
  ]);
  if (!directHttpsUrl) {
    throw new Error('Connection token is missing direct_https_url.');
  }

  const workspaceOwnerNpub = firstString(parsed, ['workspace_owner_npub', 'workspace_npub']);
  const appNpub = firstString(parsed, ['app_npub']);
  if (!workspaceOwnerNpub || !appNpub) {
    throw new Error('Connection token is missing workspace_owner_npub or app_npub.');
  }

  return {
    rawToken: String(rawToken || '').trim(),
    directHttpsUrl,
    serviceNpub: firstString(parsed, ['service_npub', 'server_npub']),
    workspaceOwnerNpub,
    workspaceOwnerPubkey: decodeNpubToHex(workspaceOwnerNpub),
    appNpub,
    appPubkey: decodeNpubToHex(appNpub),
  };
}
