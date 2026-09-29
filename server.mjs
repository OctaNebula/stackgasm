// Zero-dependency static dev server: `npm run dev` → http://localhost:5173 (opens your browser).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const noOpen = process.argv.includes('--no-open') || process.env.NO_OPEN;
let port = Number(process.env.PORT) || 5173;

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}.`)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < 5199) { port++; server.listen(port, '127.0.0.1'); return; }
  console.error(e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  \x1b[1mstack\x1b[33mg\x1b[0m\x1b[1mASM\x1b[0m  ready →  \x1b[36m${url}\x1b[0m\n  (Ctrl+C to stop)\n`);
  if (!noOpen) openBrowser(url);
});

function isWSL() {
  if (process.platform !== 'linux') return false;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') cmd = `start "" "${url}"`;
  else if (process.platform === 'darwin') cmd = `open "${url}"`;
  else if (isWSL()) cmd = `(cmd.exe /c start "" "${url}" || /mnt/c/Windows/System32/cmd.exe /c start "" "${url}" || wslview "${url}") >/dev/null 2>&1`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, { cwd: isWSL() ? '/mnt/c' : undefined }, () => {});
}
