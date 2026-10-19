// Local development server: serves public/ and runs api/chat.js like Vercel would.
// Usage: npm run dev   (reads GROQ_API_KEY / GROQ_MODEL from .env.local or .env)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT) || 3000;

for (const file of ['.env.local', '.env']) {
  const full = path.join(root, file);
  if (!existsSync(full)) continue;
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { default: chat } = await import('./api/chat.js');
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const securityHeaders = vercel.headers[0].headers;

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch { resolve(raw); } // handler rejects bad JSON
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  for (const { key, value } of securityHeaders) res.setHeader(key, value);
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/chat') {
    try {
      req.body = await readJsonBody(req);
      await chat(req, res);
    } catch (err) {
      res.statusCode = err.status || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.status ? err.message : 'Internal server error.' }));
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Karan’s Bot running at http://localhost:${port}`);
  if (!process.env.GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set. Add it to .env.local to get real replies.');
});
