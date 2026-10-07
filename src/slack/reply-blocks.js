// Composed replies: Block Kit sections the agent attaches to its FINAL streamed answer through the
// `slack_compose_reply` control tool — a chart, a sortable table, a collapsible details panel, a
// card, link buttons — so one polished message carries the takeaway and its visuals instead of a
// separate post per visual. Slack accepts blocks only on `chat.stopStream`, so the daemon keeps the
// latest staged snapshot for the turn and progress.js appends it right under the answer text,
// above the run-stats footer.
//
// Like `report_progress`, the MCP handler only validates and acknowledges: the daemon reads the
// tool call from the engine's own stream (engines/stream.js, engines/codex.js) and normalizes it
// here, so the same path serves Claude and Codex and nothing a tool result says can inject blocks.
import { z } from "zod";
import { buildChartBlock } from "./charts.js";
import { buildTableBlock, TABLE_ROW_ACTION_ID } from "./tables.js";
import { mdToMrkdwn } from "./format.js";

const TOOL_NAMES = new Set(["slack_compose_reply", "mcp__gateway__slack_compose_reply"]);

export function isReplyBlocksTool(name) {
  return TOOL_NAMES.has(name);
}

// Slack caps a stopStream at 50 blocks; the footer (stats, menu, feedback) needs a few of its own.
export const MAX_REPLY_BLOCKS = 40;
const MAX_SECTIONS = 12;
const MAX_SECTION_CHARS = 3000;
const MAX_CARD_TEXT = 150;
const MAX_CARD_BODY = 200;
const MAX_LINK_BUTTONS = 5;

const trimmed = (max) => z.string().trim().min(1).max(max);
// No zod .url(): since zod 4 it normalizes before later checks. The refine sees the raw value.
const urlSchema = z.string().max(3000).refine((value) => {
  if (value !== value.trim() || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.hostname) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}, "must be an absolute http or https URL");

const linkButtonSchema = z.object({ label: trimmed(75), url: urlSchema });

// One table cell: text, a number, or an explicit cell object (see tables.js).
export const tableCellSchema = z.union([
  z.string().max(MAX_SECTION_CHARS),
  z.number().finite(),
  z.object({
    text: z.string().max(MAX_SECTION_CHARS).optional(),
    url: urlSchema.optional(),
    user: z.string().max(40).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    strike: z.boolean().optional(),
    code: z.boolean().optional(),
    button: linkButtonSchema.optional(),
  }),
]);

export const chartFieldsSchema = {
  chart_type: z.enum(["line", "bar", "area", "pie"]),
  title: trimmed(50),
  series: z.array(z.object({
    name: trimmed(20),
    data: z.array(z.object({ label: trimmed(20), value: z.number() })).min(1).max(20),
  })).min(1).max(12).optional(),
  segments: z.array(z.object({ label: trimmed(20), value: z.number().positive() })).min(1).max(12).optional(),
  x_label: z.string().max(50).optional(),
  y_label: z.string().max(50).optional(),
};

export const tableFieldsSchema = {
  caption: trimmed(300),
  headers: z.array(trimmed(200)).min(1).max(20),
  rows: z.array(z.array(tableCellSchema).min(1).max(20)).min(1).max(200),
  page_size: z.number().int().min(1).max(100).optional(),
  row_header_column: z.number().int().min(0).max(19).optional(),
};

const sectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), markdown: trimmed(MAX_SECTION_CHARS) }),
  z.object({ type: z.literal("chart"), ...chartFieldsSchema }),
  z.object({ type: z.literal("table"), ...tableFieldsSchema }),
  z.object({
    type: z.literal("collapsible"),
    title: trimmed(MAX_CARD_TEXT),
    markdown: trimmed(MAX_SECTION_CHARS),
    collapsed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("card"),
    title: trimmed(MAX_CARD_TEXT),
    subtitle: z.string().trim().max(MAX_CARD_TEXT).optional(),
    body: z.string().trim().max(MAX_CARD_BODY).optional(),
    subtext: z.string().trim().max(MAX_CARD_BODY).optional(),
    image_url: urlSchema.optional(),
    buttons: z.array(linkButtonSchema).max(3).optional(),
  }),
  z.object({ type: z.literal("links"), buttons: z.array(linkButtonSchema).min(1).max(MAX_LINK_BUTTONS) }),
  z.object({ type: z.literal("divider") }),
]);

export const composeReplyInputSchema = z.object({
  sections: z.array(sectionSchema).min(1).max(MAX_SECTIONS),
});

function mrkdwnSection(markdown) {
  const text = mdToMrkdwn(String(markdown || "")).trim();
  if (!text) throw new Error("A text section cannot be empty.");
  if (text.length > MAX_SECTION_CHARS) throw new Error(`A text section must be ${MAX_SECTION_CHARS} characters or fewer once rendered.`);
  return { type: "section", text: { type: "mrkdwn", text } };
}

// Card copy is model text too: it goes through the same Markdown→mrkdwn conversion as a section,
// which defangs raw Slack control sequences (`<!channel>`, `<@U…>`, `<url|label>`) — a composed
// card must not be the one place an injected answer can fire a broadcast.
function cardText(value, field, max) {
  const text = mdToMrkdwn(String(value || "")).trim();
  if (text.length > max) throw new Error(`\`${field}\` must be ${max} characters or fewer once rendered.`);
  return text ? { type: "mrkdwn", text } : null;
}

function linkButton({ label, url }, actionId) {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    url,
  };
}

// Builds the Block Kit list for validated sections. Throws with a readable message on anything
// Slack would refuse, so the MCP handler can tell the model what to fix.
export function buildReplyBlocks(sections) {
  const parsed = composeReplyInputSchema.parse({ sections });
  const blocks = [];
  let buttonSeq = 0;
  parsed.sections.forEach((section, index) => {
    const field = `sections[${index}]`;
    switch (section.type) {
      case "text":
        blocks.push(mrkdwnSection(section.markdown));
        break;
      case "chart":
        blocks.push(buildChartBlock({
          chartType: section.chart_type,
          title: section.title,
          series: section.series,
          segments: section.segments,
          xLabel: section.x_label,
          yLabel: section.y_label,
        }).block);
        break;
      case "table":
        blocks.push(buildTableBlock({
          caption: section.caption,
          headers: section.headers,
          rows: section.rows,
          pageSize: section.page_size,
          rowHeaderColumn: section.row_header_column ?? 0,
          // Two tables in one reply must not repeat a row button's action_id.
          actionIdPrefix: `${TABLE_ROW_ACTION_ID}_s${index}`,
        }).block);
        break;
      case "collapsible":
        blocks.push({
          type: "container",
          title: { type: "plain_text", text: section.title, emoji: true },
          is_collapsible: true,
          default_collapsed: section.collapsed !== false,
          child_blocks: [mrkdwnSection(section.markdown)],
        });
        break;
      case "card": {
        const title = cardText(section.title, `${field}.title`, MAX_CARD_TEXT);
        if (!title) throw new Error(`\`${field}.title\` is required.`);
        const card = { type: "card", title };
        const subtitle = cardText(section.subtitle, `${field}.subtitle`, MAX_CARD_TEXT);
        const body = cardText(section.body, `${field}.body`, MAX_CARD_BODY);
        const subtext = cardText(section.subtext, `${field}.subtext`, MAX_CARD_BODY);
        if (subtitle) card.subtitle = subtitle;
        if (body) card.body = body;
        if (subtext) card.subtext = subtext;
        if (section.image_url) card.hero_image = { type: "image", image_url: section.image_url, alt_text: String(section.title).slice(0, 150) };
        if (section.buttons?.length) {
          card.actions = section.buttons.map((button) => linkButton(button, `cg_reply_link_${buttonSeq++}`));
        }
        blocks.push(card);
        break;
      }
      case "links":
        blocks.push({ type: "actions", elements: section.buttons.map((button) => linkButton(button, `cg_reply_link_${buttonSeq++}`)) });
        break;
      case "divider":
        blocks.push({ type: "divider" });
        break;
      default:
        throw new Error(`\`${field}.type\` is not supported.`);
    }
  });
  if (blocks.length > MAX_REPLY_BLOCKS) throw new Error(`A composed reply supports at most ${MAX_REPLY_BLOCKS} blocks.`);
  return blocks;
}

// A one-line description for the notification/accessibility fallback and the progress card.
export function describeReplyBlocks(sections = []) {
  const counts = new Map();
  for (const section of sections) counts.set(section.type, (counts.get(section.type) || 0) + 1);
  return [...counts].map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`).join(", ");
}

// Daemon-side normalization of the observed tool call. Returns the engine event or null when the
// input is not a valid composed reply (the model already saw the handler's validation error).
export function normalizeReplyBlocks(input) {
  let snapshot = input;
  if (typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return null;
    }
  }
  const result = composeReplyInputSchema.safeParse(snapshot);
  if (!result.success) return null;
  let blocks;
  try {
    blocks = buildReplyBlocks(result.data.sections);
  } catch {
    return null;
  }
  return { kind: "reply_blocks", blocks, summary: describeReplyBlocks(result.data.sections) };
}
