const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  // Map URL to file
  let filePath = path.join(__dirname, req.url === '/' ? '360.html' : req.url);

  // Default to HTML if no extension
  if (!path.extname(filePath)) {
    filePath += '.html';
  }

  // Determine content type
  const ext = path.extname(filePath);
  let contentType = 'text/plain';
  switch (ext) {
    case '.html':
      contentType = 'text/html';
      break;
    case '.js':
      contentType = 'application/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    case '.json':
      contentType = 'application/json';
      break;
  }

  // Read the file
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(60000, '0.0.0.0', () => {
  console.log('Server running on port 60000');
});