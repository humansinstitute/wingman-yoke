import { createNip98AuthHeader } from './nostr.js';

export class SuperbasedClient {
  constructor({ config, session, groupKeys }) {
    this.config = config;
    this.session = session;
    this.groupKeys = groupKeys;
  }

  url(pathname) {
    return new URL(pathname, this.config.directHttpsUrl).toString();
  }

  async request(pathname, { method = 'GET', body = null, authHeader = null } = {}) {
    const url = this.url(pathname);
    const authorization = authHeader || createNip98AuthHeader(url, method, body, this.session.secret);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${text}`);
    }
    return response.json();
  }

  getGroups() {
    return this.request(`/api/v4/groups?owner_npub=${encodeURIComponent(this.session.npub)}`);
  }

  getGroupKeys() {
    return this.request(`/api/v4/groups/keys?member_npub=${encodeURIComponent(this.session.npub)}`);
  }

  fetchRecords(recordFamilyHash, since = null) {
    const params = new URLSearchParams({
      owner_npub: this.config.workspaceOwnerNpub,
      viewer_npub: this.session.npub,
      record_family_hash: recordFamilyHash,
    });
    if (since) params.set('since', since);
    return this.request(`/api/v4/records?${params.toString()}`);
  }

  async syncRecords(records) {
    const proofBody = {
      owner_npub: this.config.workspaceOwnerNpub,
      records,
    };
    const groupWriteTokens = {};
    for (const record of records) {
      const groupNpub = String(record.write_group_npub || '').trim();
      if (!groupNpub || groupWriteTokens[groupNpub]) continue;
      const keyEntry = this.groupKeys.get(groupNpub);
      if (!keyEntry?.secret) throw new Error(`Missing local group key for ${groupNpub}`);
      groupWriteTokens[groupNpub] = createNip98AuthHeader(this.url('/api/v4/records/sync'), 'POST', proofBody, keyEntry.secret);
    }
    return this.request('/api/v4/records/sync', {
      method: 'POST',
      body: {
        ...proofBody,
        group_write_tokens: groupWriteTokens,
      },
    });
  }

  getStorageDownloadUrl(objectId) {
    return this.request(`/api/v4/storage/${objectId}/download-url`);
  }

  prepareStorageObject(body) {
    return this.request('/api/v4/storage/prepare', {
      method: 'POST',
      body,
    });
  }

  async uploadPreparedStorageObject(prepared, bytes, contentType = 'application/octet-stream') {
    const uploadUrl = String(prepared?.upload_url || '').trim();
    if (!uploadUrl) {
      throw new Error('Missing upload URL for storage object.');
    }
    const directResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: bytes,
    });
    if (directResponse.ok) {
      return {
        object_id: prepared.object_id,
        size_bytes: bytes.byteLength,
        content_type: contentType,
      };
    }
    return this.request(`/api/v4/storage/${prepared.object_id}`, {
      method: 'PUT',
      body: {
        base64_data: Buffer.from(bytes).toString('base64'),
      },
    });
  }

  completeStorageObject(objectId, body = {}) {
    return this.request(`/api/v4/storage/${objectId}/complete`, {
      method: 'POST',
      body,
    });
  }
}
