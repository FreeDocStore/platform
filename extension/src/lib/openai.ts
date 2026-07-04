// OpenAI chat-completions wrapper with multi-turn tool use.
//
// The adapter gives us a tool dispatcher; we run a loop of
// (assistant -> tool result) up to MAX_TURNS, returning one of:
//   - PlainReply        : assistant message, no tool call.
//   - Clarification     : ask_clarification tool call.
//   - EditProposal      : edit_file tool call (terminal write).
//   - NavProposal       : update_nav_config tool call (terminal write).
//
// Read tools (list_pages, read_page) feed their results back into the
// conversation; the loop then asks the model what to do next. Writes
// (edit_file, update_nav_config) short-circuit - once we have a write
// proposal we stop, apply it, and return.
//
// Endpoint: POST https://api.openai.com/v1/chat/completions

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

// Re-exports: a lot of existing callers (adapters, tests) import these
// names from "../lib/openai". Keep that surface stable.
export type {
  ClarificationRequest,
  ClarificationResult,
  CreateProposal,
  CreateResult,
  EditProposal,
  EditResult,
  MemoryProposal,
  MemoryResult,
  MultiTurnResult,
  NavProposal,
  NavResult,
  PlainReply,
  ToolCall,
} from "./tools";
export { MAX_TURNS } from "./tools";

import {
  SYSTEM_PROMPT,
  MARKDOWN_SYSTEM_PROMPT,
  NAV_ADDENDUM,
  READ_SYSTEM_PROMPT,
} from "./prompts";

// Tool schemas live in ./tools so the Claude adapter can reuse them.

// ── Multi-turn driver ────────────────────────────────────────────────

export interface CallOpenAIArgs {
  apiKey: string;
  model: string;
  /**
   * "edit" adds edit_file (+ update_nav_config when a navConfig is
   * supplied). "read" keeps the write tools out of the tool list.
   */
  mode: "edit" | "read";
  sourcePath: string;
  /**
   * Source language of the file being edited. "markdown" when the page is
   * built from .md/.mdx (Zensical/MkDocs); "html" for hand-authored docs.
   * Selects the editing prompt and the grounding code-fence language.
   * Defaults to "html" when omitted (back-compat).
   */
  sourceFormat?: "html" | "markdown";
  /** Full source HTML in edit mode; visible text in read mode. */
  fileContent: string;
  pageTitle?: string;
  /** Published URL of the current page. In read mode the agent uses it to
   *  cite navigable source links (page URL + #heading-slug anchors). */
  pageUrl?: string;
  userPrompt: string;
  /**
   * Text the user highlighted on the rendered page, with the nearest
   * heading for scope. The exact change target: the agent matches this
   * against the source file and edits only the corresponding span.
   */
  selection?: { text: string; heading?: string } | null;
  /** Present in edit mode when the site uses inject-nav. */
  navConfig?: NavConfig | null;
  /**
   * Optional system-prompt prefix appended after the role/style prompt
   * but before the grounded user message. Used to inject team context
   * the model should see every turn (recent docs activity, shared
   * memory etc.). Empty string is fine and produces no effect.
   */
  systemContext?: string;
  /**
   * Recent chat turns (user + assistant). Injected between the system
   * prompt and the freshly-grounded user message so multi-turn requests
   * like "switched" (after the model said "switch to Edit mode") stay
   * coherent. Only role + content are sent; UI metadata is dropped.
   */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Adapter-supplied tool dispatcher. Called with a ToolCall; returns
   * the tool-message content (JSON string) to feed back to the model.
   * Only list_pages and read_page reach this - write tools are handled
   * by the driver as terminal results.
   */
  dispatch: (call: ToolCall) => Promise<string>;
}

export async function callOpenAIMultiTurn(args: CallOpenAIArgs): Promise<MultiTurnResult> {
  const isEdit = args.mode === "edit";
  // The current nav is only in context for HTML sites (docs/nav.json). The
  // NAV_ADDENDUM + injecting the current nav are gated on that. The nav TOOL
  // itself is offered in ALL edit modes now (see below) - update_nav_config is
  // generator-aware and edits mkdocs.yml on Markdown sites, reading it first.
  const hasNavConfig = isEdit && !!args.navConfig;
  const isMarkdown = args.sourceFormat === "markdown";

  let systemContent: string;
  if (isEdit) {
    const base = isMarkdown ? MARKDOWN_SYSTEM_PROMPT : SYSTEM_PROMPT;
    systemContent = hasNavConfig ? base + NAV_ADDENDUM : base;
  } else {
    systemContent = READ_SYSTEM_PROMPT;
  }
  // Append team-context block (activity log, shared memory, etc.) AFTER
  // the role/style prompt so the model still treats role rules as the
  // primary instruction and team-context as supporting background.
  if (args.systemContext && args.systemContext.trim()) {
    systemContent = `${systemContent}\n\n${args.systemContext.trim()}`;
  }

  // Read tools available in BOTH read and edit mode. list_pages /
  // read_page cover the docs site; list_repo_files / read_repo_file
  // cover the rest of the repo (so the agent can verify "what the docs
  // claim" against "what the code does"). Write tools are added below
  // only in edit mode.
  const tools: unknown[] = [
    LIST_PAGES_TOOL,
    READ_PAGE_TOOL,
    LIST_REPO_FILES_TOOL,
    READ_REPO_FILE_TOOL,
    ASK_CLARIFICATION_TOOL,
  ];
  if (isEdit) {
    tools.push(EDIT_FILE_TOOL);
    tools.push(CREATE_PAGE_TOOL);
    // Offer the nav tool in ALL edit modes, not just when we have a
    // docs/nav.json in context. On MkDocs sites the nav lives in mkdocs.yml
    // (outside page context) and update_nav_config is the only way to touch
    // it - gating on hasNavConfig meant the tool was never offered there and
    // the model fell back to edit_file(mkdocs.yml), which the write clamp
    // correctly refuses. The tool self-describes reading mkdocs.yml first.
    tools.push(UPDATE_NAV_CONFIG_TOOL);
    // Memory writes are gated on edit mode for the same reason: they
    // commit to the repo. Read-mode users can still influence memory
    // via the existing MEMORY.md file in source control.
    tools.push(REMEMBER_TOOL);
  }

  // When the user highlighted text on the page, surface it as the
  // authoritative change target. It's rendered text, so it appears ~verbatim
  // in the source regardless of generator - the agent locates it and scopes
  // the edit there. Format-agnostic by construction.
  const selBlock = (() => {
    const sel = args.selection;
    if (!sel || !sel.text.trim()) return null;
    const where = sel.heading ? ` (under heading "${sel.heading}")` : "";
    return [
      `The user selected this exact text on the rendered page${where}. This is`,
      `the change target: find the source that produces it and scope your edit`,
      `to it only. Do not touch anything outside it.`,
      ``,
      `"""`,
      sel.text.trim(),
      `"""`,
      ``,
    ].join("\n");
  })();

  const fence = isMarkdown ? "markdown" : "html";
  const groundingParts: string[] = [];
  if (isEdit) {
    groundingParts.push(
      `Source path: \`${args.sourcePath}\``,
      ``,
      `Current file content:`,
      ``,
      `\`\`\`${fence}`,
      args.fileContent,
      `\`\`\``,
      ``,
    );
    if (hasNavConfig && args.navConfig) {
      groundingParts.push(
        `Site nav config (docs/nav.json):`,
        ``,
        `\`\`\`json`,
        args.navConfig.raw,
        `\`\`\``,
        ``,
      );
    }
    if (selBlock) groundingParts.push(selBlock);
    groundingParts.push(`Requested change:`, args.userPrompt);
  } else {
    groundingParts.push(
      `Current page: \`${args.sourcePath}\`${args.pageTitle ? ` ("${args.pageTitle}")` : ""}`,
      ...(args.pageUrl ? [`Current page URL: ${args.pageUrl}`] : []),
      ``,
      `Page content:`,
      ``,
      args.fileContent,
      ``,
    );
    if (selBlock) groundingParts.push(selBlock);
    groundingParts.push(`Question: ${args.userPrompt}`);
  }

  const recent = (args.history ?? []).slice(-6);
  // OpenAI message list: typed loosely so we can append assistant
  // messages with tool_calls and tool-role messages with tool_call_id.
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemContent },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: groundingParts.join("\n") },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const choice = await callCompletion(args.apiKey, args.model, messages, tools);

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { kind: "plain", content: choice.content ?? "(empty response)" };
    }

    // Persist the assistant turn exactly as OpenAI returned it. The API
    // requires tool-role messages to match `tool_call_id` against the
    // assistant message's `tool_calls[*].id`.
    messages.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: toolCalls,
    });

    // Terminal tools - return immediately without dispatching anything.
    // Priority (not array order): clarification > edit_file > nav. When
    // the model emits multiple terminals in one turn, the safer one wins:
    // ask_clarification beats a commit, and edit beats nav (edit is more
    // common; nav has to be explicit in the prompt to matter).
    const byName = new Map<string, (typeof toolCalls)[number]>();
    for (const tc of toolCalls) {
      if (tc.function?.name) byName.set(tc.function.name, tc);
    }
    const clar = byName.get("ask_clarification");
    if (clar) {
      return {
        kind: "clarification",
        clarification: parseToolArgs<ClarificationRequest>(clar.function.arguments),
      };
    }
    const editTc = byName.get("edit_file");
    if (editTc) {
      return {
        kind: "edit",
        proposal: parseToolArgs<EditProposal>(editTc.function.arguments),
      };
    }
    const createTc = byName.get("create_page");
    if (createTc) {
      return {
        kind: "create",
        proposal: parseToolArgs<CreateProposal>(createTc.function.arguments),
      };
    }
    const navTc = byName.get("update_nav_config");
    if (navTc) {
      return {
        kind: "nav",
        proposal: parseToolArgs<NavProposal>(navTc.function.arguments),
      };
    }
    const memTc = byName.get("remember");
    if (memTc) {
      return {
        kind: "memory",
        proposal: parseToolArgs<MemoryProposal>(memTc.function.arguments),
      };
    }

    // Read tools: dispatch each and feed the results back. We send one
    // tool message per tool_call so the model can see per-call results.
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? "";
      let args_: unknown;
      try {
        args_ = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (err) {
        throw new Error(
          `OpenAI returned unparseable tool arguments for ${name}: ${(err as Error).message}`,
        );
      }
      const result = await args.dispatch({ id: tc.id, name, args: args_ });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  return {
    kind: "plain",
    content:
      "Agent exceeded 8 turns without finishing. Simplify the prompt or ask a narrower question.",
  };
}

// ── Low-level chat-completions call ──────────────────────────────────

interface CompletionChoice {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

async function callCompletion(
  apiKey: string,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
): Promise<CompletionChoice> {
  const body = {
    model,
    messages,
    tools,
    // `auto` gives the model room to reply in prose when that's the
    // right answer (e.g. after a read_page that answered the question).
    tool_choice: "auto" as const,
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices: Array<{ message: CompletionChoice }>;
  };
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error("OpenAI response missing message");
  return choice;
}

function parseToolArgs<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `OpenAI returned unparseable tool arguments: ${(err as Error).message}`,
    );
  }
}
