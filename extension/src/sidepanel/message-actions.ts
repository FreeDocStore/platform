export function messageAsMarkdown(role: "user" | "assistant", content: string): string {
  if (role === "assistant") return `### Assistant reply\n\n${content}`;
  return `### Your message\n\n${content.split("\n").map((line) => `> ${line}`).join("\n")}`;
}

export async function copyMarkdown(markdown: string, clipboard: Pick<Clipboard, "writeText"> | null | undefined): Promise<boolean> {
  try {
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(markdown);
    return true;
  } catch {
    return false;
  }
}

export async function copyWithFeedback(
  markdown: string,
  clipboard: Pick<Clipboard, "writeText"> | null | undefined,
  feedback: { textContent: string | null },
): Promise<boolean> {
  const copied = await copyMarkdown(markdown, clipboard);
  feedback.textContent = copied ? "Copied" : "Copy failed. Check clipboard permission and try again.";
  return copied;
}

export function renderDraftChip(
  container: HTMLDivElement,
  draft: string | null,
  onRemove: () => void,
): void {
  container.replaceChildren();
  container.hidden = !draft;
  if (!draft) return;
  const label = document.createElement("span");
  label.className = "draft-chip-text";
  label.textContent = `Attached draft · ${draft}`;
  label.title = draft;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "draft-chip-remove";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", "Remove attached draft");
  remove.addEventListener("click", onRemove);
  container.append(label, remove);
}
