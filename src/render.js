const STORAGE_LINK_RE = /storage:\/\/([a-f0-9-]+)/gi;

export function extractStorageObjectIds(text) {
  const ids = new Set();
  for (const match of String(text || '').matchAll(STORAGE_LINK_RE)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export async function resolveStorageLinks(client, text) {
  const objectIds = extractStorageObjectIds(text);
  const resolved = [];
  for (const objectId of objectIds) {
    try {
      const result = await client.getStorageDownloadUrl(objectId);
      resolved.push({
        object_id: objectId,
        download_url: result.download_url,
      });
    } catch (error) {
      resolved.push({
        object_id: objectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return resolved;
}
