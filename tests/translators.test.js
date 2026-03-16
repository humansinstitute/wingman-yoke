import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { outboundDocument, outboundTask } from '../src/translators.js';

function makeSession() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    secret,
    npub: nip19.npubEncode(pubkey),
  };
}

function makeNpub() {
  return nip19.npubEncode(getPublicKey(generateSecretKey()));
}

test('outboundDocument prefers person share via group for write_group_npub', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const privateGroup = makeNpub();
  const sharedGroup = makeNpub();
  const document = {
    record_id: 'doc-1',
    owner_npub: ownerNpub,
    title: 'Doc',
    content: 'Body',
    shares: [
      {
        type: 'group',
        group_npub: privateGroup,
        access: 'write',
      },
      {
        type: 'person',
        person_npub: session.npub,
        via_group_npub: sharedGroup,
        access: 'write',
      },
    ],
    group_ids: [privateGroup, sharedGroup],
    version: 3,
  };
  const envelope = outboundDocument('npub1app', session, document);
  assert.equal(envelope.write_group_npub, sharedGroup);
});

test('outboundTask uses explicit board group when provided', () => {
  const session = makeSession();
  const ownerNpub = makeNpub();
  const groupA = makeNpub();
  const groupB = makeNpub();
  const task = {
    record_id: 'task-1',
    owner_npub: ownerNpub,
    title: 'Task',
    description: '',
    shares: [],
    group_ids: [groupA, groupB],
    board_group_id: groupB,
    version: 1,
  };
  const envelope = outboundTask('npub1app', session, task);
  assert.equal(envelope.write_group_npub, groupB);
});
