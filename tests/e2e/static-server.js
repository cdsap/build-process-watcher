const http = require('http');
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '../../frontend/public');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const requestedPath = pathname === '/' ? '/compare.html' : pathname;
  const filePath = path.resolve(publicDir, `.${requestedPath}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(contents);
  });
}).listen(4173, '127.0.0.1');
