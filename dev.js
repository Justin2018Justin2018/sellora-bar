// Local development: node dev.js  (needs DATABASE_URL and COOKIE_SECURE=0 in the environment)
const http = require('http'), fs = require('fs'), path = require('path'), handler = require('./api/index.js');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { u.searchParams.set('__p', u.pathname.slice(5)); req.url = '/api/index' + u.search; return handler(req, res); }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(3000, () => console.log('http://localhost:3000'));
