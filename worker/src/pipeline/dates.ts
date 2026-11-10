import { DateTime } from 'luxon';

export interface ResolvedDate {
  iso: string; // UTC instant
  dateOnly: boolean;
}

/**
 * Convert a local wall-clock string from the model into a UTC instant.
 * "YYYY-MM-DDTHH:mm" is taken as that time in `zone`.
 * "YYYY-MM-DD" becomes the start of that day (events) or 23:59 that day (task deadlines).
 * A time that doesn't exist (spring-forward gap) moves forward to the next valid time.
 * An ambiguous time (autumn fall-back) takes the first occurrence.
 */
export function localToUtc(local: string | null, zone: string, dateOnlyAs: 'start' | 'end'): ResolvedDate | null {
  if (!local) return null;
  const dateOnly = !local.includes('T');
  const dt = dateOnly
    ? DateTime.fromISO(local, { zone }).set(
        dateOnlyAs === 'end' ? { hour: 23, minute: 59 } : { hour: 0, minute: 0 },
      )
    : DateTime.fromISO(local, { zone });
  if (!dt.isValid) return null;
  // When clocks go back, one wall-clock time happens twice. Always take the first.
  const first = dt.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0] ?? dt;
  return { iso: first.toUTC().toISO({ suppressMilliseconds: true })!, dateOnly };
}

/** The received date as the model should see it, e.g. "Tuesday 2026-11-10 14:05 (America/New_York)". */
export function formatAnchor(received: Date, zone: string): string {
  const dt = DateTime.fromJSDate(received, { zone });
  return `${dt.toFormat('cccc yyyy-LL-dd HH:mm')} (${zone})`;
}

export function utcToLocal(iso: string | null, zone: string): string | null {
  if (!iso) return null;
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function isValidZone(zone: string): boolean {
  return /^[A-Za-z_]+\/[A-Za-z0-9_+\-\/]+$|^UTC$/.test(zone) && DateTime.local().setZone(zone).isValid;
}
