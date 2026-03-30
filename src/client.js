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

  async requestRaw(pathname, { method = 'GET', body = null, authHeader = null, headers = {} } = {}) {
    const url = this.url(pathname);
    const authorization = authHeader || createNip98AuthHeader(url, method, body, this.session.secret);
    return fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  async request(pathname, options = {}) {
    const response = await this.requestRaw(pathname, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${text}`);
    }
    return response.json();
  }

  getGroups() {
    return this.request(`/api/v4/groups?npub=${encodeURIComponent(this.session.npub)}`);
  }

  getGroupKeys() {
    return this.request(`/api/v4/groups/keys?member_npub=${encodeURIComponent(this.session.npub)}`);
  }

  rotateGroup(groupId, body) {
    return this.request(`/api/v4/groups/${encodeURIComponent(groupId)}/rotate`, {
      method: 'POST',
      body,
    });
  }

  async fetchRecords(recordFamilyHash, since = null) {
    const PAGE_SIZE = 200;
    let offset = 0;
    let allRecords = [];

    while (true) {
      const params = new URLSearchParams({
        owner_npub: this.config.workspaceOwnerNpub,
        viewer_npub: this.session.npub,
        record_family_hash: recordFamilyHash,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (since) params.set('since', since);
      const page = await this.request(`/api/v4/records?${params.toString()}`);
      const records = page.records ?? [];
      allRecords = allRecords.concat(records);
      if (!page.has_more || records.length === 0) break;
      offset += records.length;
    }

    return { records: allRecords };
  }

  getRecordHistory(recordId) {
    const params = new URLSearchParams({
      owner_npub: this.config.workspaceOwnerNpub,
      viewer_npub: this.session.npub,
    });
    return this.request(`/api/v4/records/${encodeURIComponent(recordId)}/history?${params.toString()}`);
  }

  async syncRecords(records) {
    const normalizedRecords = (records || []).map((record) => {
      const normalized = { ...record };
      const writeGroupNpub = String(record?.write_group_npub || '').trim();
      if (writeGroupNpub) {
        normalized.write_group_npub = writeGroupNpub;
        delete normalized.write_group_id;
        return normalized;
      }

      const writeGroupId = String(record?.write_group_id || '').trim();
      if (writeGroupId) normalized.write_group_id = writeGroupId;
      return normalized;
    });
    const proofBody = {
      owner_npub: this.config.workspaceOwnerNpub,
      records: normalizedRecords,
    };
    const groupWriteTokens = {};
    for (const record of normalizedRecords) {
      const groupRef = String(record.write_group_id || record.write_group_npub || '').trim();
      if (!groupRef || groupWriteTokens[groupRef]) continue;
      const keyEntry = this.groupKeys.getCurrent
        ? this.groupKeys.getCurrent(groupRef)
        : this.groupKeys.get(groupRef);
      if (!keyEntry?.secret) throw new Error(`Missing local group key for ${groupRef}`);
      groupWriteTokens[groupRef] = createNip98AuthHeader(this.url('/api/v4/records/sync'), 'POST', proofBody, keyEntry.secret);
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

  getStorageObject(objectId) {
    return this.request(`/api/v4/storage/${objectId}`);
  }

  getStorageContentUrl(objectId) {
    return this.url(`/api/v4/storage/${objectId}/content`);
  }

  async getStorageContent(objectId) {
    const response = await this.requestRaw(`/api/v4/storage/${objectId}/content`);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${text}`);
    }
    return new Uint8Array(await response.arrayBuffer());
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
