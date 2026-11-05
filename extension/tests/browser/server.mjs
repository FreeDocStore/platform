import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const root = resolve('..');
const fixture = `<!doctype html><html><head><meta name="source-sha" content="${'a'.repeat(40)}"><title>Reader test</title></head><body>
<nav>Navigation must not be spoken</nav><main><article><h1>Reader guide</h1><p>First sentence. Second sentence.</p><table><tr><th>Plan</th><th>Cost</th></tr><tr><td>Public</td><td>Free</td></tr></table><aside><p>Remember this useful note.</p></aside><pre>secret code not spoken</pre></article></main>
<script src="/reader.js"></script></body></html>`;
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/_fixture') {
    let html = fixture;
    if (url.searchParams.has('audio')) {
      const sha = (url.searchParams.get('audio') === 'fresh' ? 'a' : 'b').repeat(40);
      html = html.replace('</head>', `<meta name="audio-file" content="/audio/fds-audio-${'1'.repeat(20)}.wav"><meta name="audio-sha" content="${sha}"></head>`);
    }
    if (url.searchParams.has('chain')) {
      const first = url.searchParams.get('chain') === 'start';
      const active = 'md-nav__link md-nav__link--active';
      html = html.replace('<nav>Navigation must not be spoken</nav>', `<nav class="md-nav--primary"><a class="${first ? active : 'md-nav__link'}" href="/_fixture?chain=start">First</a><a class="${first ? 'md-nav__link' : active}" href="/_fixture?chain=next">Next</a></nav>`);
    }
    res.setHeader('content-type', 'text/html'); return res.end(html);
  }
  if (url.pathname === '/_audio') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>Audio test</title>'); }
  const file = url.pathname === '/reader.js' ? resolve(root, 'templates/read-aloud/read-aloud.js') : url.pathname.startsWith('/edit/') || ['/', '/provision', '/publish', '/profile'].includes(url.pathname) ? resolve(root, 'apps/editor/web/dist/index.html') : resolve(root, 'apps/editor/web/dist', `.${url.pathname}`);
  const dist = resolve(root, 'apps/editor/web/dist');
  if ((url.pathname !== '/reader.js' && !file.startsWith(`${dist}/`)) || !existsSync(file)) { res.statusCode = 404; return res.end(); }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(4319, '127.0.0.1');
