import { z } from "zod";

// Only `report_progress` is registered and advertised (see mcp/tools/background.js). The
// retired `workflow_progress` names stay here as INERT aliases: an admin `gateway-usage`
// overlay written before the rename can still be telling a model the old name, and rendering
// that snapshot beats silently dropping it. Nothing emits them anymore.
const TOOL_NAMES = new Set([
  "report_progress",
  "mcp__gateway__report_progress",
  "workflow_progress",
  "mcp__gateway__workflow_progress",
]);

const trimmedNonblank = (max) => z.string().trim().min(1).max(max);
// No zod .url() here: since zod 4 it normalizes (trims) before later checks, which would let
// padded URLs through — the refine below is the full validator and sees the raw value.
const sourceUrlSchema = z.string().max(2_000).refine((value) => {
  if (value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.hostname) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}, "Source URL must be an absolute http or https URL");

const progressReportStepSchema = z.object({
  id: trimmedNonblank(80),
  title: trimmedNonblank(240),
  status: z.enum(["pending", "in_progress", "complete", "error"]),
  details: z.string().trim().max(2_000).optional(),
  output: z.string().trim().max(2_000).optional(),
  sources: z.array(z.object({
    url: sourceUrlSchema,
    text: trimmedNonblank(240),
  })).max(10).optional(),
});

const progressReportStepsSchema = z.array(progressReportStepSchema).min(1).max(20).superRefine((steps, context) => {
  const ids = new Set();
  let activeSteps = 0;

  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "Step IDs must be unique",
      });
    }
    ids.add(step.id);
    if (step.status === "in_progress") activeSteps += 1;
  }

  if (activeSteps > 1) {
    context.addIssue({
      code: "custom",
      message: "At most one step may be in progress",
    });
  }
});

export const progressReportInputSchema = z.object({
  title: trimmedNonblank(80),
  steps: progressReportStepsSchema,
});

export function isProgressReportTool(name) {
  return TOOL_NAMES.has(name);
}

export function normalizeProgressReport(input) {
  let snapshot = input;
  if (typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return null;
    }
  }

  const result = progressReportInputSchema.safeParse(snapshot);
  if (!result.success) return null;

  return {
    kind: "report_progress",
    title: result.data.title,
    steps: result.data.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      details: step.details ?? "",
      output: step.output ?? "",
      sources: step.sources ?? [],
    })),
  };
}
