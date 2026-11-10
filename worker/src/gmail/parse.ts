import { htmlToText } from '../pipeline/clean.js';
import type { ParsedMessage } from '../types.js';

function decode(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findPart(part: any, mime: string): string {
  if (!part) return '';
  if (part.mimeType === mime && part.body?.data && !part.filename) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return '';
}

/** Gmail API message (format=full) to the fields the pipeline needs. Attachments are ignored. */
export function parseGmailMessage(raw: any): ParsedMessage {
  const headers: Record<string, string> = {};
  for (const h of raw.payload?.headers ?? []) {
    const name = String(h.name).toLowerCase();
    if (!(name in headers)) headers[name] = String(h.value ?? '');
  }
  const plain = findPart(raw.payload, 'text/plain');
  const bodyText = plain || htmlToText(findPart(raw.payload, 'text/html'));
  return {
    id: raw.id,
    threadId: raw.threadId ?? raw.id,
    labels: raw.labelIds ?? [],
    headers,
    from: headers['from'] ?? '',
    subject: headers['subject'] ?? '',
    receivedAt: new Date(Number(raw.internalDate ?? Date.now())),
    bodyText,
  };
}
