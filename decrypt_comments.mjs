import { nip19, nip44 } from 'nostr-tools';

const groupNsec = 'nsec1hk0q3remswpzccl3ngjqkzl74zn882gvldkl4wy5ta4mm3h56r5sglpgd3';
const groupSk = nip19.decode(groupNsec).data;

// Read comments from stdin (JSON from curl)
const input = await new Promise(r => { let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => r(d)); });
const data = JSON.parse(input);

for (const rec of data.records) {
  const gp = rec.group_payloads?.[0];
  if (!gp) continue;
  try {
    const parsed = JSON.parse(gp.ciphertext);
    const senderPk = nip19.decode(parsed.encrypted_by_npub).data;
    const ck = nip44.v2.utils.getConversationKey(groupSk, senderPk);
    const decrypted = JSON.parse(nip44.v2.decrypt(parsed.ciphertext, ck));
    const d = decrypted.data;
    console.log('---');
    console.log('ID:', rec.record_id);
    console.log('From:', rec.signature_npub.slice(0,20));
    console.log('Target:', d.target_record_id);
    console.log('Line:', d.anchor_line_number);
    console.log('Status:', d.comment_status);
    console.log('Body:', d.body);
    console.log('At:', rec.updated_at);
  } catch(e) {
    console.log('DECRYPT ERROR:', rec.record_id, e.message);
  }
}
