// Anthropic Messages API wrapper with multi-turn tool use.
//
// The Claude counterpart of lib/openai.ts. Same contract: the adapter
// hands us a tool dispatcher; we run a loop of (assistant -> tool result)
// up to MAX_TURNS and return a MultiTurnResult (plain / clarification /
// edit / nav / memory). Read tools feed results back; write tools are
// terminal. The tool SCHEMAS, MultiTurnResult shape, and the system
// prompts are shared with the OpenAI path - only the wire format of the
// API differs, which is all that lives here.
//
// Endpoint: POST https://api.anthropic.com/v1/messages

import type { NavConfig } from "../types";
import {
  ASK_CLARIFICATION_TOOL,
  CREATE_PAGE_TOOL,
  EDIT_FILE_TOOL,
  LIST_PAGES_TOOL,
  LIST_REPO_FILES_TOOL,
  MAX_TURNS,
  READ_PAGE_TOOL,
  READ_REPO_FILE_TOOL,
  REMEMBER_TOOL,
  UPDATE_NAV_CONFIG_TOOL,
} from "./tools";
import type {
  ClarificationRequest,
  CreateProposal,
  EditProposal,
  MemoryProposal,
  MultiTurnResult,
  NavProposal,
  ToolCall,
} from "./tools";
// Reuse the exact system prompts the OpenAI path uses so the two adapters
// behave identically; only the transport differs.
import { SYSTEM_PROMPT, MARKDOWN_SYSTEM_PROMPT, NAV_ADDENDUM, READ_SYSTEM_PROMPT } from "./prompts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

export interface CallClaudeArgs {
  apiKey: string;
  model: string;
  mode: "edit" | "read";
  sourcePath: string;
  /** "markdown" for .md/.mdx sources, else "html". Selects prompt + fence. */
  sourceFormat?: "html" | "markdown";
  /** Full source HTML in edit mode; visible text in read mode. */
  fileContent: string;
  pageTitle?: string;
  /** Published URL of the current page; used in read mode to cite navigable
   *  source links (page URL + #heading-slug anchors). */
  pageUrl?: string;
  userPrompt: string;
  /** Highlighted rendered text + nearest heading; the exact change target. */
  selection?: { text: string; heading?: string } | null;
  navConfig?: NavConfig | null;
  /** System-prompt prefix (memory, add-ons catalog, recent activity). */
  systemContext?: string;
  /** Recent chat turns (role + content only). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Adapter-supplied tool dispatcher; see lib/openai.ts CallOpenAIArgs. */
  dispatch: (call: ToolCall) => Promise<string>;
}

/** Anthropic content blocks we care about. */
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };

/**
 * The OpenAI tool schemas are `{ type:"function", function:{ name,
 * description, parameters } }`. Anthropic wants `{ name, description,
 * input_schema }`. Same JSON Schema underneath, so this is a pure shape
 * adapter - keeping one source of truth in lib/tools.ts.
 */
function toAnthropicTool(t: { function: { name: string; description: string; parameters: unknown } }) {
  return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters };
}

export async function callClaudeMultiTurn(args: CallClaudeArgs): Promise<MultiTurnResult> {
  const isEdit = args.mode === "edit";
  // hasNavConfig: HTML sites carry docs/nav.json in context -> gate the
  // NAV_ADDENDUM + injecting the current nav on it. The nav TOOL itself is
  // offered in all edit modes (see below); update_nav_config is generator-
  // aware and edits mkdocs.yml on Markdown sites, reading it first.
  const hasNavConfig = isEdit && !!args.navConfig;
  const isMarkdown = args.sourceFormat === "markdown";

  const editBase = isMarkdown ? MARKDOWN_SYSTEM_PROMPT : SYSTEM_PROMPT;
  let systemContent = isEdit
    ? (hasNavConfig ? editBase + NAV_ADDENDUM : editBase)
    : READ_SYSTEM_PROMPT;
  if (args.systemContext && args.systemContext.trim()) {
    systemContent = `${systemContent}\n\n${args.systemContext.trim()}`;
  }

  // Same tool set as the OpenAI path: read tools in both modes; write
  // tools (edit/nav/remember) only in edit mode.
  const toolDefs = [
    LIST_PAGES_TOOL,
    READ_PAGE_TOOL,
    LIST_REPO_FILES_TOOL,
    READ_REPO_FILE_TOOL,
    ASK_CLARIFICATION_TOOL,
  ];
  if (isEdit) {
    toolDefs.push(EDIT_FILE_TOOL);
    toolDefs.push(CREATE_PAGE_TOOL);
    // Offer the nav tool in ALL edit modes (not just when docs/nav.json is in
    // context). On MkDocs sites the nav lives in mkdocs.yml, outside page
    // context; update_nav_config is the only writer that can reach it, and it
    // self-describes reading mkdocs.yml first. Mirrors lib/openai.ts.
    toolDefs.push(UPDATE_NAV_CONFIG_TOOL);
    toolDefs.push(REMEMBER_TOOL);
  }
  const tools = toolDefs.map(toAnthropicTool);

  // Highlighted text on the rendered page = the authoritative change
  // target; it appears ~verbatim in the source, so the agent locates and
  // scopes the edit to it regardless of generator. Mirrors lib/openai.ts.
  const selBlock = (() => {
    const sel = args.selection;
    if (!sel || !sel.text.trim()) return null;
    const where = sel.heading ? ` (under heading "${sel.heading}")` : "";
    return [
      `The user selected this exact text on the rendered page${where}. This is`,
      `the change target: find the source that produces it and scope your edit`,
      `to it only. Do not touch anything outside it.`,
      ``,
      `"""`, sel.text.trim(), `"""`, ``,
    ].join("\n");
  })();

  const fence = isMarkdown ? "markdown" : "html";
  const groundingParts: string[] = [];
  if (isEdit) {
    groundingParts.push(
      `Source path: \`${args.sourcePath}\``, ``,
      `Current file content:`, ``,
      "```" + fence, args.fileContent, "```", ``,
    );
    if (hasNavConfig && args.navConfig) {
      groundingParts.push(
        `Site nav config (docs/nav.json):`, ``,
        "```json", args.navConfig.raw, "```", ``,
      );
    }
    if (selBlock) groundingParts.push(selBlock);
    groundingParts.push(`Requested change:`, args.userPrompt);
  } else {
    groundingParts.push(
      `Current page: \`${args.sourcePath}\`${args.pageTitle ? ` ("${args.pageTitle}")` : ""}`,
      ...(args.pageUrl ? [`Current page URL: ${args.pageUrl}`] : []),
      ``,
      `Page content:`, ``, args.fileContent, ``,
    );
    if (selBlock) groundingParts.push(selBlock);
    groundingParts.push(`Question: ${args.userPrompt}`);
  }

  const recent = (args.history ?? []).slice(-6);
  // Anthropic message content is either a string or an array of blocks.
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    ...recent.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: groundingParts.join("\n") },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const blocks = await callMessages(args.apiKey, args.model, systemContent, messages, tools);
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      const text = blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { kind: "plain", content: text || "(empty response)" };
    }

    // Persist the assistant turn verbatim (Anthropic requires the
    // following tool_result blocks to reference these tool_use ids).
    messages.push({ role: "assistant", content: blocks });

    // Terminal tools, same priority as the OpenAI path:
    // clarification > edit > nav > memory.
    const byName = new Map<string, ToolUseBlock>();
    for (const tu of toolUses) byName.set(tu.name, tu);

    const clar = byName.get("ask_clarification");
    if (clar) return { kind: "clarification", clarification: clar.input as ClarificationRequest };
    const editTu = byName.get("edit_file");
    if (editTu) return { kind: "edit", proposal: editTu.input as EditProposal };
    const createTu = byName.get("create_page");
    if (createTu) return { kind: "create", proposal: createTu.input as CreateProposal };
    const navTu = byName.get("update_nav_config");
    if (navTu) return { kind: "nav", proposal: navTu.input as NavProposal };
    const memTu = byName.get("remember");
    if (memTu) return { kind: "memory", proposal: memTu.input as MemoryProposal };

    // Read tools: dispatch each, return all results in one user message.
    const toolResults: Array<Record<string, unknown>> = [];
    for (const tu of toolUses) {
      const result = await args.dispatch({ id: tu.id, name: tu.name, args: tu.input });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    kind: "plain",
    content:
      "Agent exceeded 8 turns without finishing. Simplify the prompt or ask a narrower question.",
  };
}

async function callMessages(
  apiKey: string,
  model: string,
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: unknown }>,
  tools: unknown[],
): Promise<ContentBlock[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // Required for browser-context callers (the extension) so Anthropic
      // returns permissive CORS headers.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages, tools, tool_choice: { type: "auto" } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: ContentBlock[] };
  return data.content ?? [];
}
