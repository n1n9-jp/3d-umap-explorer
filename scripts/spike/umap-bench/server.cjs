// 計測用の静的サーバー: dist/ を配り、/data/ は .cache/ を、POST /save は .cache/results/ へ書く
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

function start(port = 0) {
  const results = path.join(ROOT, '.cache', 'results');
  fs.mkdirSync(results, { recursive: true });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/save') {
      const name = path.basename(u.searchParams.get('name') || 'x');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { fs.writeFileSync(path.join(results, name + '.f32'), Buffer.concat(chunks)); res.end('ok'); });
      return;
    }
    let file;
    if (u.pathname.startsWith('/data/')) file = path.join(ROOT, '.cache', path.basename(u.pathname));
    else file = path.join(ROOT, 'dist', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
module.exports = { start };
if (require.main === module) start(5199).then((s) => console.log('http://127.0.0.1:' + s.address().port));
