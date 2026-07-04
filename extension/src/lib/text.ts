// HTML -> visible-text stripper for the read_page tool.
//
// MV3 service workers don't have DOMParser, so we do this with regex.
// Good enough: the model needs to grep content for references, not
// render the page. We strip script/style/nav (and their contents),
// comments, and then any remaining tags. Entities get decoded for the
// common named cases plus all numeric entities.
//
// We deliberately KEEP <header> and <footer> - those often carry real
// content (page hero copy, copyright, "Edit on GitHub" links) that the
// user asks about ("is there a footer?", "what's in the footer?").
// <nav> is still stripped because it's the topbar, which is identical
// on every page and just inflates token counts.

function decodeEntities(s: string): string {
  return s
    // Numeric first so `&amp;#8230;` stays as `&#8230;` after single-step decode.
    .replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // `&amp;` last so the `&` it produces isn't re-matched by earlier
    // named entities (which it wouldn't match anyway, but keep the order
    // explicit so future edits don't regress).
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(cp: number): string {
  // Guard against invalid code points (e.g. &#0;, &#1114112;); fall back
  // to an empty string so the model doesn't see garbage.
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

export function htmlToVisibleText(html: string): string {
  const stripped = html
    .replace(/<(script|style|nav)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

/**
 * Pull the <title> out of the raw HTML. Runs before the stripper so a
 * leading nav (which can contain inline text like "Docs / Foo") can't
 * shadow the real document title. Entities in the title are decoded so
 * the model sees "Foo & Bar" not "Foo &amp; Bar".
 */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return decodeEntities(m[1]).replace(/\s+/g, " ").trim();
}

/**
 * True if `url` parses as an http(s) URL. The single canonical check used
 * everywhere a persisted/model-supplied string is about to become an href
 * (blocks javascript:/data:/etc.). Previously duplicated across board.ts,
 * markdown.ts, and inline regexes.
 */
export function isHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse an "owner/name" repo key into its parts. Returns null when the key
 * is malformed (missing/leading/trailing slash), so callers never end up
 * with an `undefined` owner or name flowing into a GitHub URL.
 */
export function parseRepoKey(key: string): { owner: string; name: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return null;
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}
