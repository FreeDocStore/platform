// A small DOM shim for unit-testing the pure render modules (edits-list,
// preview-card, thread-banner, pop-menu) in node, without a browser or jsdom.
// It covers exactly what those modules touch: element creation, class/style/
// dataset/attributes, append/replaceChildren, a bubbling event model (so
// stopPropagation + document-level closers work), querySelectorAll for simple
// selectors, and getBoundingClientRect/window dims for pop-menu positioning.
//
// Call installDom() once (top of a test file, before importing the module under
// test via bundle()), then reset() in beforeEach. fire(el, type, props)
// dispatches a bubbling event; el.click() is shorthand for a click.

class ClassList {
  constructor(node) { this.node = node; this._set = new Set(); }
  add(...cs) { for (const c of cs) if (c) this._set.add(c); this._sync(); }
  remove(...cs) { for (const c of cs) this._set.delete(c); this._sync(); }
  toggle(c, force) {
    const has = this._set.has(c);
    const on = force === undefined ? !has : force;
    if (on) this._set.add(c); else this._set.delete(c);
    this._sync();
    return on;
  }
  contains(c) { return this._set.has(c); }
  _sync() { this.node._className = [...this._set].join(" "); }
  _load(str) { this._set = new Set((str || "").split(/\s+/).filter(Boolean)); }
}

class El {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : undefined;
    this.nodeType = tag ? 1 : 11; // 11 = fragment when tag is null
    this._className = "";
    this.classList = new ClassList(this);
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); this.classList._load(this._className); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  set textContent(v) { this.childNodes = [{ nodeType: 3, textValue: String(v), parentNode: this }]; }
  get textContent() { return collectText(this); }
  appendChild(c) {
    if (c && c.nodeType === 11) { for (const g of [...c.childNodes]) this.appendChild(g); return c; }
    c.parentNode = this; this.childNodes.push(c); return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? { nodeType: 3, textValue: c } : c); }
  replaceChildren(...cs) { this.childNodes = []; for (const c of cs) this.appendChild(c); }
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) { n.parentNode = this.parentNode; this.parentNode.childNodes[i] = n; }
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  click() { fire(this, "click"); }
  getBoundingClientRect() { return this._rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

function collectText(node) {
  if (node.nodeType === 3) return node.textValue;
  return (node.childNodes || []).map(collectText).join("");
}

// ── simple selector matching (tag, #id, .class, [attr], [attr="v"]) ──
function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /(\[[^\]]+\]|[.#]?[\w-]+)/g;
  let m;
  while ((m = re.exec(sel))) {
    const tok = m[1];
    if (tok.startsWith(".")) out.classes.push(tok.slice(1));
    else if (tok.startsWith("#")) out.id = tok.slice(1);
    else if (tok.startsWith("[")) {
      const inner = tok.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq === -1) out.attrs.push({ name: inner, value: undefined });
      else out.attrs.push({ name: inner.slice(0, eq), value: inner.slice(eq + 1).replace(/^["']|["']$/g, "") });
    } else out.tag = tok.toUpperCase();
  }
  return out;
}
function matchesSimple(node, parsed) {
  if (node.nodeType !== 1) return false;
  if (parsed.tag && node.tagName !== parsed.tag) return false;
  if (parsed.id && node.attributes.id !== parsed.id && node.id !== parsed.id) return false;
  for (const c of parsed.classes) if (!node.classList.contains(c)) return false;
  for (const a of parsed.attrs) {
    const dataName = a.name.startsWith("data-") ? a.name.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase()) : null;
    const val = dataName && node.dataset[dataName] !== undefined ? node.dataset[dataName] : node.getAttribute(a.name);
    if (val == null) return false;
    if (a.value !== undefined && String(val) !== a.value) return false;
  }
  return true;
}
function descendants(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.nodeType === 1) { out.push(c); descendants(c, out); }
  }
  return out;
}
function queryAll(root, selector) {
  // Support a descendant chain "a b c": match the final segment among
  // descendants whose ancestors satisfy the earlier segments in order.
  const segs = selector.trim().split(/\s+/).map(parseSimple);
  const last = segs[segs.length - 1];
  const cands = descendants(root).filter((n) => matchesSimple(n, last));
  if (segs.length === 1) return cands;
  return cands.filter((n) => {
    let ai = segs.length - 2;
    for (let p = n.parentNode; p && ai >= 0; p = p.parentNode) {
      if (matchesSimple(p, segs[ai])) ai--;
    }
    return ai < 0;
  });
}

// ── bubbling event dispatch ──
export function fire(target, type, props = {}) {
  const event = {
    type, target, defaultPrevented: false, _stop: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    ...props,
  };
  for (let n = target; n; n = n.parentNode) {
    for (const fn of (n._listeners?.[type] || [])) fn.call(n, event);
    if (event._stop) break;
  }
  // document is the ultimate ancestor: an un-stopped event reaches its
  // delegated listeners (this is what closeAllPopMenus relies on).
  if (!event._stop && globalThis.document?._listeners?.[type]) {
    for (const fn of globalThis.document._listeners[type]) fn.call(globalThis.document, event);
  }
  return event;
}
function fireWindow(type, props = {}) {
  const event = { type, ...props };
  for (const fn of (globalThis.window._listeners?.[type] || [])) fn(event);
}

let docRoot;
export function installDom() {
  docRoot = new El("body");
  const document = {
    body: docRoot,
    visibilityState: "visible",
    _listeners: {},
    createElement: (t) => new El(t),
    createTextNode: (v) => ({ nodeType: 3, textValue: String(v) }),
    createDocumentFragment: () => new El(null),
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
    querySelector(sel) { return queryAll(docRoot, sel)[0] ?? null; },
    querySelectorAll(sel) { return queryAll(docRoot, sel); },
  };
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 400, innerHeight: 800, _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
  };
  globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
  return { document, fire, fireDocument: (type, props) => {
    const ev = { type, ...props };
    for (const fn of (document._listeners[type] || [])) fn(ev);
  }, fireWindow };
}

export function reset() {
  docRoot.childNodes = [];
  globalThis.document._listeners = {};
  globalThis.window._listeners = {};
}

/** Attach a rendered subtree to the document body so document.querySelectorAll finds it. */
export function mount(node) { globalThis.document.body.appendChild(node); return node; }
