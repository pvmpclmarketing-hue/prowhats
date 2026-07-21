const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const safe = path.normalize(file).replace(/^(\.\.([\\/]|$))+/, '');
  const target = path.join(root, safe);
  if (!target.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(target, (error, content) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); return res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
    res.end(content);
  });
}).listen(process.env.PORT || 3000, () => console.log('Fluxo WhatsApp em http://localhost:3000'));
