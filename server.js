const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 60000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mpd':  'application/dash+xml',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.m4s':  'video/iso.segment',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const handler = (req, res) => {
  // CORS + headers comunes (necesario p/ Web Audio con crossorigin).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  // 1) Quitar query string (?ayaw=90…) y decodificar la ruta.
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    pathname = req.url.split('?')[0];
  }

  // 2) '/' → index.html
  if (pathname === '/') pathname = '/index.html';

  // 3) Resolver dentro de ROOT (evita path traversal).
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      console.warn('404', req.url, '→', filePath);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found: ' + pathname);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const total = stat.size;
    const range = req.headers.range;

    // 4) Soporte de Range (seek de vídeo/audio directos y MSE).
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end(); return;
      }
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
};

// HTTPS si existen certificados (necesario para WebXR/VR fuera de localhost);
// si no, HTTP con aviso. Genera los certs con: ./gen-cert.sh
const KEY = process.env.TLS_KEY || path.join(ROOT, 'certs', 'key.pem');
const CRT = process.env.TLS_CERT || path.join(ROOT, 'certs', 'cert.pem');

let server, scheme;
if (fs.existsSync(KEY) && fs.existsSync(CRT)) {
  server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, handler);
  scheme = 'https';
} else {
  server = http.createServer(handler);
  scheme = 'http';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${scheme}://0.0.0.0:${PORT}  (root: ${ROOT})`);
  if (scheme === 'http') {
    console.warn('⚠  Sin certificados → HTTP. WebXR (VR) NO funciona por IP sin HTTPS.');
    console.warn('   Genera un certificado autofirmado:  ./gen-cert.sh   y reinicia.');
  }
});
