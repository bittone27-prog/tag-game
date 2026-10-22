// Serveur statique minimal pour Render (aucune dépendance)
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erreur serveur'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, () => console.log('TAG en ligne sur le port ' + PORT));
