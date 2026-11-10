function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Mask card numbers, passwords, account numbers and one-time codes before anything leaves the VPS. */
export function redact(text: string): string {
  let out = text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[CARD]' : m;
  });
  out = out.replace(
    /\b(pass(?:word|code|phrase)?|pwd|pin)\b(\s*(?:is|was|:|=)\s*)(\S+)/gi,
    (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`,
  );
  out = out.replace(
    /\b(account|acct|routing|iban|sort code|member|policy)(\s*(?:number|no\.?|#)?\s*(?:is|:|=|ending in)?\s*)([A-Z]{0,4}[\d][\d -]{5,30}\d)/gi,
    (_m, k: string, sep: string) => `${k}${sep}[ACCOUNT]`,
  );
  out = out.replace(
    /\b((?:verification|security|login|one[- ]time|2fa|otp)\s*(?:code|passcode|pin)?\s*(?:is|:)?\s*)(\d{4,8})\b/gi,
    (_m, k: string) => `${k}[CODE]`,
  );
  return out;
}
