import { createSpeechSourceWith, readableBlocks, resolveVoiceChoices, type Source } from '../../../templates/read-aloud/src/reader.js';
import { getActiveTabContext, activeTabId, querySelectionFromTab } from './tab-messaging';

/** Panel playback owns its own preferences and always stops at a tab change. */
export function initNarration(): void {
  const root = document.getElementById('narration')!;
  const play = root.querySelector<HTMLButtonElement>('[data-play]')!;
  const stop = root.querySelector<HTMLButtonElement>('[data-stop]')!;
  const status = root.querySelector<HTMLElement>('[role=status]')!;
  const target = root.querySelector<HTMLSelectElement>('[data-target]')!;
  const rate = root.querySelector<HTMLInputElement>('[data-rate]')!;
  const voice = root.querySelector<HTMLSelectElement>('[data-voice]')!;
  let source: Source | null = null;
  let paused = false;
  let generation = 0;
  let windowId: number | undefined;
  let tabId: number | null = null;
  let current = 0;
  const key = 'freedocstore.panel-narration.v1';
  const reset = () => {
    generation++;
    source?.stop();
    source = null;
    paused = false;
    play.textContent = 'Listen';
    status.textContent = 'Ready';
  };
  void chrome.windows.getCurrent().then(w => { windowId = w.id; });
  void chrome.storage.local.get(key).then(result => {
    const prefs = result[key];
    if (Number.isFinite(prefs?.rate)) rate.value = String(Math.min(2, Math.max(0.5, prefs.rate)));
    return resolveVoiceChoices().then(voices => {
      for (const v of voices.list) voice.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
      if (voices.list.some(v => v.voiceURI === prefs?.voice)) voice.value = prefs.voice;
    });
  }).catch(() => { status.textContent = 'Could not load listening preferences.'; });
  const save = () => void chrome.storage.local.set({ [key]: { rate: Number(rate.value), voice: voice.value } });
  rate.addEventListener('change', save);
  voice.addEventListener('change', () => { reset(); save(); });
  target.addEventListener('change', reset);
  stop.addEventListener('click', reset);
  for (const delta of [-1, 1]) {
    root.querySelector(`[data-skip="${delta}"]`)!.addEventListener('click', () => source?.seekTo(current + delta));
  }
  play.addEventListener('click', () => void (async () => {
    if (source) {
      if (paused) {
        if (tabId != null) await chrome.tabs.sendMessage(tabId, { type: 'STOP_PAGE_NARRATION' });
        source?.resume();
      } else source.pause();
      if (!source) return;
      paused = !paused;
      play.textContent = paused ? 'Resume' : 'Pause';
      return;
    }
    const mine = ++generation;
    play.disabled = true;
    status.textContent = 'Preparing local voice…';
    try {
      tabId = await activeTabId();
      const voices = await resolveVoiceChoices();
      const chosen = voices.choose(voice.value);
      if (!chosen) throw new Error('Install an on-device speech voice to listen.');
      let blocks;
      if (target.value === 'answer') {
        const answers = document.querySelectorAll<HTMLElement>('.messages .message.assistant');
        const answer = answers[answers.length - 1];
        if (!answer) throw new Error('There is no answer to read yet.');
        blocks = readableBlocks(answer.querySelector('.body') ?? answer);
      } else {
        const selection = target.value === 'selection' ? await querySelectionFromTab() : null;
        const context = target.value === 'page' ? await getActiveTabContext() : null;
        const text = selection?.text ?? context?.text;
        if (!text?.trim()) throw new Error(target.value === 'selection' ? 'Select text on the page first.' : 'Open a readable knowledge-base page first.');
        blocks = [{ kind: 'para', text }];
      }
      if (mine !== generation) return;
      if (tabId != null) await chrome.tabs.sendMessage(tabId, { type: 'STOP_PAGE_NARRATION' });
      if (mine !== generation) return;
      const next = createSpeechSourceWith(blocks, chosen, undefined, () => Number(rate.value));
      if (!next) throw new Error('Nothing to read.');
      source = next;
      next.onEnded(reset);
      next.onYielded?.(reset);
      next.onError(message => { reset(); status.textContent = message; });
      next.onProgress(p => { current = p.index; status.textContent = `Local voice · ${p.index + 1} of ${p.total}`; });
      next.start();
      play.textContent = 'Pause';
    } catch (error) {
      if (mine === generation) { reset(); status.textContent = error instanceof Error ? error.message : String(error); }
    } finally { play.disabled = false; }
  })());
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'PAGE_NARRATION_STARTED' && sender.id === chrome.runtime.id && sender.tab?.id === tabId && sender.tab?.windowId === windowId) reset();
  });
  chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId) reset(); });
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.url || change.status === 'loading')) reset(); });
  window.addEventListener('pagehide', reset);
}
