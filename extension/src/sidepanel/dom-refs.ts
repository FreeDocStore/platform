// The side panel's DOM element references, resolved once at load. Split out of
// sidepanel.ts so the extracted concern modules (selection-chip, thread-ui,
// message-view, …) can share the same element handles instead of re-querying.
//
// NOTE: unlike the shared lib/dom helpers, this module DOES run querySelector at
// import time. That's fine here because the side-panel modules are never
// bundle-imported by tests (only sidepanel.html loads them, where the DOM
// exists). Keep DOM-ref resolution in THIS file only; never at the top level of
// a module a test bundles.

import { $ } from "../lib/dom";

export const messagesEl = $(".messages");
export const newBelowChip = $<HTMLButtonElement>("#new-below-chip");
export const startCardEl = $<HTMLElement>("#start-card");
export const promptEl = $<HTMLTextAreaElement>("#prompt");
export const formEl = $<HTMLFormElement>("#chat-form");
// `button[type="submit"]` is explicit - the form now contains the mic button
// (type="button") which would otherwise win the bare selector.
export const sendBtn = formEl.querySelector('button[type="submit"]') as HTMLButtonElement;
export const micBtn = $<HTMLButtonElement>("#mic-btn");
export const interimEl = $<HTMLElement>("#dictation-interim");
export const threadSelectEl = $<HTMLButtonElement>("#thread-select");
export const threadMenuEl = $<HTMLElement>("#thread-menu");
export const editsBtn = $<HTMLButtonElement>("#edits-btn");
export const editsListEl = $<HTMLElement>("#edits-list");
export const commitModeToggle = $<HTMLButtonElement>("#commit-mode-toggle");
export const settingsBtn = $<HTMLButtonElement>("#settings-btn");
export const copyChatBtn = $<HTMLButtonElement>("#copy-chat-btn");
export const clearChatBtn = $<HTMLButtonElement>("#clear-chat-btn");
export const moreBtn = $<HTMLButtonElement>("#more-btn");
export const moreMenuEl = $<HTMLElement>("#more-menu");
export const threadNavEl = $<HTMLElement>("#thread-nav");
export const chatAreaEl = $<HTMLElement>("#chat-area");
export const noRepoStateEl = $<HTMLElement>("#no-repo-state");
export const contextSectionEl = $<HTMLElement>("#context");
export const contextEl = $(".context-summary .repo");
export const selChipEl = $<HTMLDivElement>("#selection-chip");
export const selChipTextEl = $<HTMLSpanElement>("#selection-chip-text");
export const selChipClearBtn = $<HTMLButtonElement>("#selection-chip-clear");
export const selIndicatorEl = $<HTMLSpanElement>("#sel-indicator");
export const accessBadgeEl = $<HTMLSpanElement>("#access-badge");
export const bannerEl = $<HTMLElement>("#thread-banner");
export const boardBtn = $<HTMLButtonElement>("#board-btn");
