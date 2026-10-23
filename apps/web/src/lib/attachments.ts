import { MAX_ATTACHMENT_BYTES, type Attachment } from '@harv/shared';

/** Uploads one file into the tab's attachment folder on the Harv server. */
export async function uploadAttachment(tabId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`);
  const params = new URLSearchParams({ tab: tabId, name: file.name || 'pasted-image.png' });
  const res = await fetch(`/api/attachments?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return (await res.json()) as Attachment;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
