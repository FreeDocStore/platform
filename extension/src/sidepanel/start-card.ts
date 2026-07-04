// The "new request" start card: fills the conversation area when you begin a
// fresh request, so an empty chat reads as a clean start rather than a
// continuation of the previous thread. It lets you pick Ask vs Edit, shows the
// page you're working on, and explains the flow in three steps.
//
// Pure renderer (no chrome.*, no module state, no import-time side effects): it
// takes a view model + callbacks and builds DOM, so it's unit-testable with the
// DOM shim. The panel owns WHEN to show it (state.composing) and wires the
// callbacks to the real thread-switch functions.

export interface StartCardContext {
  /** Page title of the page being worked on. */
  title?: string;
  /** A short path to show (published path like "/about/", or a source path). */
  path?: string | null;
  /** "owner/name" of the backing repo, when known. */
  repoLabel?: string | null;
  /** The pinned on-page selection text, if any (else "whole page"). */
  selectionText?: string | null;
}

export interface StartCardView {
  /** The card container (cleared and populated). */
  container: HTMLElement;
  /** Which mode is currently selected. */
  mode: "ask" | "edit";
  /** False disables the Edit toggle (read-only repo). */
  canEdit: boolean;
  /** Page context to summarise, or null when there's no page. */
  context: StartCardContext | null;
  onPickAsk: () => void;
  onPickEdit: () => void;
  /** Discard the new request and leave compose mode (the ✕ button). */
  onDiscard: () => void;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function renderStartCard(v: StartCardView): void {
  v.container.replaceChildren();

  // Header row: title + a discard (✕) button so a new request that was opened
  // by mistake can be abandoned without sending anything.
  const head = document.createElement("div");
  head.className = "sc-head";
  const title = document.createElement("div");
  title.className = "sc-title";
  title.textContent = "What do you want to do?";
  head.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sc-close";
  close.textContent = "✕";
  close.title = "Discard this new request";
  close.setAttribute("aria-label", "Discard new request");
  close.addEventListener("click", v.onDiscard);
  head.appendChild(close);
  v.container.appendChild(head);

  // Ask / Edit segmented toggle.
  const seg = document.createElement("div");
  seg.className = "sc-seg";
  seg.setAttribute("role", "group");
  const mkMode = (
    label: string,
    active: boolean,
    disabled: boolean,
    hint: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sc-mode" + (active ? " active" : "");
    b.textContent = label;
    b.title = hint;
    b.disabled = disabled;
    b.setAttribute("aria-pressed", String(active));
    if (!disabled) b.addEventListener("click", onClick);
    return b;
  };
  seg.appendChild(
    mkMode("❓ Ask", v.mode === "ask", false, "Ask a read-only question about this page", v.onPickAsk),
  );
  seg.appendChild(
    mkMode(
      "✎ Edit",
      v.mode === "edit",
      !v.canEdit,
      v.canEdit ? "Propose a change to this page" : "Read-only access to this repo — editing is disabled",
      v.onPickEdit,
    ),
  );
  v.container.appendChild(seg);

  // Context block — the page you're working on.
  const ctx = v.context;
  if (ctx && (ctx.title || ctx.path || ctx.selectionText || ctx.repoLabel)) {
    const label = document.createElement("div");
    label.className = "sc-label";
    label.textContent = "Context";
    v.container.appendChild(label);

    const box = document.createElement("div");
    box.className = "sc-ctx";
    const row = (icon: string, text: string) => {
      const r = document.createElement("div");
      r.className = "sc-ctx-row";
      r.textContent = `${icon}  ${text}`;
      box.appendChild(r);
    };
    if (ctx.title) row("📄", ctx.title);
    if (ctx.path) row("🔗", ctx.path);
    if (ctx.repoLabel) row("📦", ctx.repoLabel);
    row("✂", ctx.selectionText ? `"${truncate(ctx.selectionText)}"` : "Whole page as context");
    v.container.appendChild(box);
  }

  // How it works — adapts to the selected mode.
  const howLabel = document.createElement("div");
  howLabel.className = "sc-label";
  if (v.mode === "edit") {
    howLabel.textContent = "How editing works";
    v.container.appendChild(howLabel);
    const ol = document.createElement("ol");
    ol.className = "sc-steps";
    for (const step of [
      "Describe the change below; there is no manual content editor here.",
      "I draft it and show you a diff to review.",
      "Click Apply for the GitHub-backed change, or open GitHub for manual edits.",
    ]) {
      const li = document.createElement("li");
      li.textContent = step;
      ol.appendChild(li);
    }
    v.container.appendChild(ol);
  } else {
    howLabel.textContent = "About Ask";
    v.container.appendChild(howLabel);
    const note = document.createElement("p");
    note.className = "sc-note";
    note.textContent =
      "Read-only. I answer questions about this page and the docs. Switch to Edit to request an AI-authored proposal; use GitHub for manual edits.";
    v.container.appendChild(note);
  }
}
