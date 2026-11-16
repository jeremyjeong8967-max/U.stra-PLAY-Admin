// Local demo only. A fixed allowlist keeps other project files private.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const admin = 'U.stra PLAY-Admin.html';
const games = 'U.stra PLAY-Games.html';
http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = pathname === '/' ? admin : pathname.slice(1);
    if (![admin, games].includes(file)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const content = fs.readFileSync(path.join(__dirname, '..', file));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(400); response.end('Bad request');
  }
}).listen(8765, '127.0.0.1', () => {
  console.log('Open http://127.0.0.1:8765/ in Edge or Chrome. Stop with Ctrl+C.');
});
