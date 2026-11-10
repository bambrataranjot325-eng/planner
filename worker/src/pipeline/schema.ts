import { z } from 'zod';

const LocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'must be YYYY-MM-DD or YYYY-MM-DDTHH:mm, no timezone')
  .nullable();

export const ExtractedItem = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(500),
  kind: z.enum(['event', 'task']),
  start_local: LocalDateTime,
  end_local: LocalDateTime,
  due_local: LocalDateTime,
  due_precision: z.enum(['exact', 'date_only', 'approximate']).nullable(),
  course: z.string().trim().max(40).nullable(),
  priority: z.enum(['high', 'medium', 'low']),
  priority_reason: z.string().trim().max(200),
  category: z.enum(['work', 'study', 'personal', 'finance', 'health', 'admin', 'other']),
  action_required: z.boolean(),
  confidence: z.number().min(0).max(1),
  updates_item_id: z.string().uuid().nullable().optional(),
  cancelled: z.boolean().optional(),
  resolved: z.boolean().optional(),
  optional: z.boolean().optional(), // an opportunity, not a commitment
  timezone: z.string().trim().max(60).nullable().optional(),
  end_timezone: z.string().trim().max(60).nullable().optional(),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractionResult = z.object({ items: z.array(ExtractedItem).max(30) });
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/** Parse a model reply. Returns the validated result or a short error to feed back on retry. */
export function parseExtraction(text: string): { ok: true; value: ExtractionResult } | { ok: false; error: string } {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  const r = ExtractionResult.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
