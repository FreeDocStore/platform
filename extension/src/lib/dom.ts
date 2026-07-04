// Tiny DOM helpers shared across the UI entry points (side panel, board,
// options, content). Import-safe: nothing here touches the DOM at module load
// time - every function runs `document` only when called - so this module can
// be bundle-imported by tests.

/** `querySelector` with a caller-chosen element type (defaults to HTMLElement). */
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;

/** `querySelectorAll` as a real array (so `.map`/`.filter` just work). */
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

/** createElement + optional className + optional textContent, in one call. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
