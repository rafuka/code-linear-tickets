import { z } from "zod";

export const Priority = z.enum(["urgent", "high", "medium", "low", "no_priority"]);
export type Priority = z.infer<typeof Priority>;

/**
 * Parsed metadata from the @linear-start delimiter comment block.
 *
 * Delimiter format in source code:
 *
 *   // @linear-start
 *   // id: auth-redirect-fix          (optional but recommended — stable slug for updates)
 *   // title: Fix broken auth redirect
 *   // priority: high
 *   // labels: bug, auth
 *   // assignee: user@example.com    (optional — Linear user email)
 *   // team: ENG                      (optional — overrides CLI --team flag)
 *   <code to capture>
 *   // @linear-end
 *
 * The `id` field is a user-defined stable slug. When present, changes to the
 * code or metadata inside the block will update the existing Linear issue
 * rather than creating a new one. Without `id`, any content change produces
 * a new ticket.
 */
export const TicketMetaSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "title is required"),
  priority: Priority.default("no_priority"),
  labels: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean)
        : []
    ),
  assignee: z.string().email().optional(),
  team: z.string().optional(),
});

export type TicketMeta = z.infer<typeof TicketMetaSchema>;

export const LINEAR_PRIORITY_MAP: Record<Priority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  no_priority: 0,
};

/** A fully-resolved snippet ready to be sent to Linear. */
export interface Snippet {
  meta: TicketMeta;
  code: string;
  file: string;
  startLine: number;
  endLine: number;
  /**
   * SHA-256 hash of the snippet's content (title + code). Changes whenever
   * the code or metadata inside the markers is edited.
   */
  contentHash: string;
  /**
   * Stable identifier used as the lockfile key.
   * Equals `meta.id` when provided, otherwise falls back to `contentHash`.
   * With a user-supplied `id`, this stays constant across edits so the tool
   * can update the existing issue rather than creating a new one.
   */
  stableId: string;
}
