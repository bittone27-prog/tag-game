// Serveur TAG : fichiers statiques + WebSocket maison (aucune dépendance)
// Le serveur gère les salons et fait tourner la partie (autoritaire).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;

/* ===== HTTP ===== */
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erreur serveur'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

/* ===== WEBSOCKET MINIMAL (RFC 6455) ===== */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function send(sock, obj) {
  if (!sock || sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { sock.write(Buffer.concat([header, payload])); } catch (e) {}
}

function parseFrames(sock, chunk, onMessage) {
  sock.buf = Buffer.concat([sock.buf || Buffer.alloc(0), chunk]);
  while (sock.buf.length >= 2) {
    const b = sock.buf;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let payload = b.slice(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = b.slice(off, off + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    }
    sock.buf = b.slice(need);
    if (opcode === 0x8) { sock.end(); return; }
    if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0])); } catch (e) {} continue; }
    if (opcode === 0x1) {
      try { onMessage(JSON.parse(payload.toString('utf8'))); } catch (e) {}
    }
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const client = { sock, room: null, idx: -1 };
  sock.on('data', c => parseFrames(sock, c, m => onMessage(client, m)));
  sock.on('close', () => onLeave(client));
  sock.on('error', () => onLeave(client));
});

/* ===== LOGIQUE DU JEU (serveur) ===== */
const W = 960, H = 540, GROUND = H - 40, DURATION = 60;
const PLATS = [{x:120,y:400,w:200},{x:640,y:400,w:200},{x:380,y:300,w:200},{x:40,y:230,w:180},{x:740,y:230,w:180},{x:380,y:170,w:200}];
const rooms = {};

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)]; } while (rooms[c]);
  return c;
}

function lobbyInfo(room) {
  return { type: 'lobby', code: room.code, max: room.max, count: room.clients.length, started: room.started };
}

function broadcast(room, obj) { room.clients.forEach(c => send(c.sock, obj)); }

function onMessage(client, m) {
  if (m.type === 'create') {
    if (client.room) return;
    const max = Math.max(2, Math.min(4, parseInt(m.max, 10) || 2));
    const room = { code: makeCode(), max, clients: [], started: false, players: [], timeLeft: DURATION, timer: null };
    rooms[room.code] = room;
    joinRoom(client, room);
  } else if (m.type === 'join') {
    const room = rooms[String(m.code || '').toUpperCase().trim()];
    if (!room) return send(client.sock, { type: 'error', msg: 'Salon introuvable.' });
    if (room.started) return send(client.sock, { type: 'error', msg: 'La partie a déjà commencé.' });
    if (room.clients.length >= room.max) return send(client.sock, { type: 'error', msg: 'Salon complet.' });
    joinRoom(client, room);
  } else if (m.type === 'input') {
    const room = client.room;
    if (!room || !room.started) return;
    const p = room.players[client.idx];
    if (p) { p.in = { l: !!m.l, r: !!m.r, j: !!m.j }; }
  } else if (m.type === 'leave') {
    onLeave(client);
  }
}

function joinRoom(client, room) {
  client.room = room;
  client.idx = room.clients.length;
  room.clients.push(client);
  send(client.sock, { type: 'joined', code: room.code, you: client.idx, max: room.max });
  broadcast(room, lobbyInfo(room));
  if (room.clients.length === room.max) startRoom(room);
}

function startRoom(room) {
  room.started = true;
  room.timeLeft = DURATION;
  room.players = room.clients.map((c, i) => ({
    i, x: 120 + i * 220, y: 100, vx: 0, vy: 0, w: 34, h: 34,
    cat: false, time: 0, imm: 0, ground: false, face: 1, in: { l: false, r: false, j: false }
  }));
  room.players[Math.floor(Math.random() * room.players.length)].cat = true;
  broadcast(room, { type: 'start', n: room.players.length });
  let last = Date.now();
  room.timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(room, dt);
  }, 1000 / 60);
}

function step(room, dt) {
  room.timeLeft -= dt;
  room.players.forEach(p => {
    const sp = p.cat ? 330 : 290;
    p.vx = 0;
    if (p.in.l) { p.vx = -sp; p.face = -1; }
    if (p.in.r) { p.vx = sp; p.face = 1; }
    if (p.in.j && p.ground) { p.vy = -640; p.ground = false; }
    p.vy += 1700 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.x < -p.w) p.x = W;
    if (p.x > W) p.x = -p.w;
    p.ground = false;
    if (p.y + p.h >= GROUND) { p.y = GROUND - p.h; p.vy = 0; p.ground = true; }
    PLATS.forEach(pl => {
      if (p.vy >= 0 && p.x + p.w > pl.x && p.x < pl.x + pl.w && p.y + p.h >= pl.y && p.y + p.h - p.vy * dt <= pl.y + 4) {
        p.y = pl.y - p.h; p.vy = 0; p.ground = true;
      }
    });
    if (p.imm > 0) p.imm -= dt;
    if (p.cat) p.time += dt;
  });
  const cat = room.players.find(p => p.cat);
  if (cat && cat.imm <= 0) {
    room.players.forEach(o => {
      if (o !== cat && o.imm <= 0 && cat.x < o.x + o.w && cat.x + cat.w > o.x && cat.y < o.y + o.h && cat.y + cat.h > o.y) {
        cat.cat = false; o.cat = true; o.imm = 1.2; cat.imm = 1.2;
      }
    });
  }
  const state = {
    type: 'state', t: Math.max(0, room.timeLeft),
    p: room.players.map(p => ({ i: p.i, x: Math.round(p.x), y: Math.round(p.y), cat: p.cat, time: +p.time.toFixed(2), imm: +Math.max(0, p.imm).toFixed(2), face: p.face }))
  };
  broadcast(room, state);
  if (room.timeLeft <= 0) endRoom(room);
}

function endRoom(room) {
  clearInterval(room.timer);
  const sorted = [...room.players].sort((a, b) => a.time - b.time);
  broadcast(room, { type: 'end', ranking: sorted.map(p => ({ i: p.i, time: +p.time.toFixed(2) })) });
  room.clients.forEach(c => { c.room = null; c.idx = -1; });
  delete rooms[room.code];
}

function onLeave(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  if (room.started) {
    // un joueur part : on arrête la partie pour tout le monde
    clearInterval(room.timer);
    broadcast(room, { type: 'error', msg: 'Un joueur a quitté la partie.' , abort: true });
    room.clients.forEach(c => { c.room = null; c.idx = -1; });
    delete rooms[room.code];
  } else {
    room.clients = room.clients.filter(c => c !== client);
    room.clients.forEach((c, i) => { c.idx = i; });
    if (!room.clients.length) delete rooms[room.code];
    else { broadcast(room, lobbyInfo(room)); room.clients.forEach(c => send(c.sock, { type: 'you', you: c.idx })); }
  }
}

server.listen(PORT, () => console.log('TAG en ligne sur le port ' + PORT));
