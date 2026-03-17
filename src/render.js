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
      const storageObject = await client.getStorageObject(objectId);
      resolved.push({
        object_id: objectId,
        file_name: storageObject.file_name || null,
        content_type: storageObject.content_type || null,
        size_bytes: storageObject.size_bytes ?? null,
        content_url: storageObject.content_url || client.getStorageContentUrl(objectId),
        download_url: storageObject.download_url || null,
        completed_at: storageObject.completed_at || null,
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
