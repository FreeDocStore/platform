// Dictation UI: browser-native speech-to-text. Chrome uses Google's cloud
// recogniser (no API key, needs internet). The mic button in the chat form
// toggles it; so does Cmd/Ctrl+Shift+M from anywhere inside the side panel.
//
// Extracted from sidepanel.ts. initDictation() wires the mic button + shortcut
// and takes an `onAssistantNote` callback so an error can surface as a chat
// message without this module depending on the conversation core.

import { createDictation, isSupported as dictationSupported } from "./dictation";
import { dlog } from "./debug-bridge";
import { interimEl, promptEl, micBtn } from "./dom-refs";

function setInterim(text: string): void {
  if (interimEl) interimEl.textContent = text;
}

function appendToPrompt(text: string): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  const existing = promptEl.value;
  const sep = existing && !/\s$/.test(existing) ? " " : "";
  promptEl.value = existing + sep + cleaned;
  // Move caret to the end so continued typing appends rather than inserts.
  promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
}

/**
 * Wire dictation. `onAssistantNote` surfaces a dictation error as an assistant
 * chat message (injected so this module stays off the conversation core).
 */
export function initDictation(onAssistantNote: (content: string) => void): void {
  const dictation = createDictation({
    onInterim: setInterim,
    onFinal: (text) => {
      appendToPrompt(text);
      setInterim("");
    },
    onError: (code, message) => {
      setInterim("");
      micBtn?.classList.remove("active");
      // `no-speech` and `aborted` are the natural end conditions; keep the
      // UI quiet on those. Everything else surfaces as a chat note so the
      // user knows why dictation stopped. Prefer the caller-supplied
      // message (it carries actionable details from the mic probe) and
      // only fall back to canned strings when the module gives us
      // nothing useful.
      if (code === "no-speech" || code === "aborted") return;
      // Fallback only fires when the dictation module didn't supply a
      // message (e.g. SpeechRecognition's own onerror, where e.message is
      // usually empty). Keep the advice consistent with the probeMic
      // message: the address-bar mic toggle covers the docs page, NOT the
      // side panel - the user needs Chrome's per-extension setting.
      const extId = chrome?.runtime?.id ?? "";
      const micSettings = extId
        ? `chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${extId}`
        : "chrome://settings/content/microphone";
      const fallback =
        code === "not-allowed"
          ? `Microphone permission denied. Open ${micSettings} and set Microphone to Allow for this extension.`
          : code === "network"
            ? "Dictation failed: the speech service is unreachable (check your internet connection)."
            : code === "not-supported"
              ? "Dictation isn't supported in this browser."
              : `Dictation stopped: ${code}`;
      const reason = message && message.trim().length > 0 ? message : fallback;
      onAssistantNote(reason);
      dlog("dictation error", { code, message });
    },
    onEnd: () => {
      setInterim("");
      micBtn?.classList.remove("active");
    },
  });

  if (micBtn && !dictationSupported()) {
    micBtn.disabled = true;
    micBtn.title = "Dictation isn't available in this browser";
  }

  micBtn?.addEventListener("click", () => {
    if (dictation.isActive()) {
      dictation.stop();
    } else {
      // start() never rejects (probeMic + rec.start route failures to onError);
      // void it to match the repo's fire-and-forget convention.
      void dictation.start();
      micBtn.classList.add("active");
    }
  });

  // Cmd/Ctrl+Shift+M toggles. Listener is on `window` so the shortcut works
  // whether the user has focus in the textarea, a dropdown, or the panel body.
  // Scoped to the side panel - there's no global shortcut.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    if (e.key !== "m" && e.key !== "M") return;
    e.preventDefault();
    if (!micBtn || micBtn.disabled) return;
    micBtn.click();
  });
}
