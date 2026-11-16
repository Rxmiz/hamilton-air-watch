// Tiny static server for ./site. Optional: `--refresh <minutes>` re-runs `npm run update` periodically.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('./site/', import.meta.url));
const PORT = +process.env.PORT || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!path || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(PORT, () => console.log(`Hamilton Air Watch → http://localhost:${PORT}`));

const i = process.argv.indexOf('--refresh');
if (i > -1) {
  const mins = +process.argv[i + 1] || 60;
  const run = () => spawn(process.execPath, ['scripts/fetch-readings.mjs'], { stdio: 'inherit' })
    .on('exit', code => code === 0 && spawn(process.execPath, ['scripts/attribute.mjs'], { stdio: 'inherit' }));
  setInterval(run, mins * 60e3);
  console.log(`Refreshing sensor data every ${mins} min`);
}
