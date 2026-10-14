// Local development: node dev.js  (needs DATABASE_URL, DATABASE_SSL=off and COOKIE_SECURE=0 in the environment)
const http = require('http'), fs = require('fs'), path = require('path'), handler = require('./api/index.js');
const PUB = path.join(__dirname, 'public'), TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { u.searchParams.set('__p', u.pathname.slice(5)); req.url = '/api/index' + u.search; return handler(req, res); }
  let rel; try { rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); } catch (e) { res.statusCode = 400; return res.end('Bad request'); }
  const f = path.resolve(PUB, '.' + rel);
  if (f !== PUB && !f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(fs.readFileSync(f));
}).listen(3000, () => console.log('http://localhost:3000'));
