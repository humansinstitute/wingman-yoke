import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  buildWrappedMemberKeys,
  createGroupIdentity,
  decryptFromNpub,
} from '../src/nostr.js';

function makeNpub(secret = generateSecretKey()) {
  return nip19.npubEncode(getPublicKey(secret));
}

test('buildWrappedMemberKeys wraps the rotated nsec once per unique member', () => {
  const wrappedBySecret = generateSecretKey();
  const wrappedByNpub = nip19.npubEncode(getPublicKey(wrappedBySecret));
  const memberSecrets = [generateSecretKey(), generateSecretKey()];
  const memberNpubs = [
    makeNpub(memberSecrets[0]),
    makeNpub(memberSecrets[1]),
    makeNpub(memberSecrets[0]),
  ];
  const groupIdentity = createGroupIdentity();

  const memberKeys = buildWrappedMemberKeys(groupIdentity, memberNpubs, wrappedByNpub, wrappedBySecret);

  assert.equal(memberKeys.length, 2);
  for (const [index, memberSecret] of memberSecrets.entries()) {
    const decrypted = decryptFromNpub(
      memberSecret,
      wrappedByNpub,
      memberKeys[index].wrapped_group_nsec,
    );
    assert.equal(decrypted, groupIdentity.nsec);
    assert.equal(memberKeys[index].wrapped_by_npub, wrappedByNpub);
  }
});
