import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { finalizeEvent, getPublicKey, nip19, nip44 } from 'nostr-tools';

function loadNsecFromBitwarden() {
  const sessionPath = join(homedir(), '.bw_session');
  const bwSession = readFileSync(sessionPath, 'utf8').trim();
  return execFileSync('bw', ['get', 'password', 'wm21-nostr'], {
    env: { ...process.env, BW_SESSION: bwSession },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function getConfiguredNsec() {
  return process.env.WINGMAN_AUTOPILOT_NSEC
    || process.env.NOSTR_NSEC
    || loadNsecFromBitwarden();
}

export function decodeNsec(nsec) {
  const decoded = nip19.decode(String(nsec).trim());
  if (decoded.type !== 'nsec') throw new Error('Invalid nsec.');
  return decoded.data;
}

export function decodeNpub(npub) {
  const decoded = nip19.decode(String(npub).trim());
  if (decoded.type !== 'npub') throw new Error(`Invalid npub: ${npub}`);
  return decoded.data;
}

export function encodeNsec(secret) {
  return nip19.nsecEncode(secret);
}

export function getSession(secret = decodeNsec(getConfiguredNsec())) {
  const pubkey = getPublicKey(secret);
  return {
    secret,
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function createNip98AuthHeader(url, method, body, secret) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body != null && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    tags.push(['payload', sha256Hex(serialized)]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

export function encryptForNpub(secret, recipientNpub, plaintext) {
  const conversationKey = nip44.v2.utils.getConversationKey(secret, decodeNpub(recipientNpub));
  return nip44.v2.encrypt(plaintext, conversationKey);
}

export function decryptFromNpub(secret, senderNpub, ciphertext) {
  const conversationKey = nip44.v2.utils.getConversationKey(secret, decodeNpub(senderNpub));
  return nip44.v2.decrypt(ciphertext, conversationKey);
}
