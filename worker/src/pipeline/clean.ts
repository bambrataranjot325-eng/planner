/** Very small HTML-to-text for emails that have no plain-text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

const QUOTE_HEADER = [
  /^On .{5,200}wrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+\n?Sent:\s/i,
  /^_{10,}\s*$/,
];
const SIGNATURE = [/^--\s?$/, /^Sent from my (iPhone|iPad|Android|phone)/i, /^Get Outlook for /i];

/** Drop quoted replies and signatures, collapse whitespace, truncate. */
export function cleanBody(raw: string, maxChars: number): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const next = `${trimmed}\n${(lines[i + 1] ?? '').trim()}`;
    if (QUOTE_HEADER.some((re) => re.test(trimmed) || re.test(next))) break; // everything below is the old thread
    if (SIGNATURE.some((re) => re.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line.replace(/[ \t]+/g, ' ').trimEnd());
  }
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[truncated]`;
  return out;
}
