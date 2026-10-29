/*
 * Coilcast – multiplayer server.
 * Spuštění:  npm install  &&  npm start   →  http://localhost:3000
 * Na Renderu: render.yaml (PORT nastaví Render sám).
 * Jeden proces = statické soubory hry + WebSocket na /ws.
 *
 * Arény:
 *  - veřejné: hráči se dělí po ROOM_MAX, prázdná místa doplňují boti
 *  - lobby (soukromé): kdo má kód nebo odkaz s ?lobby=KÓD, hraje ve stejné aréně
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('../shared/game.js');

const PORT = process.env.PORT || 3000;
const ROOM_MAX = Number(process.env.ROOM_MAX || 20);
const LOBBY_MAX = Number(process.env.LOBBY_MAX || 12);
const TICK = 1 / 40;          // simulace 40× za sekundu
const SNAP_EVERY = 2;         // snapshot klientům 20× za sekundu
const FULL_EVERY = 4;         // minimapa + žebříček jen v každém 4. snímku (5× za sekundu)

const ROOT = path.join(__dirname, '..');
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/game.js': ['shared/game.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml']
};

/* ---------- arény ---------- */
const rooms = [];
let roomSeq = 1;
function newRoom(lobby) {
  const r = { id: roomSeq++, lobby: lobby || null, world: G.createWorld(), clients: new Map(), tick: 0 };
  rooms.push(r); console.log(`arena #${r.id} created${lobby ? ' for lobby ' + lobby.code : ''}`);
  return r;
}
function publicRoom() { return rooms.find(r => !r.lobby && r.clients.size < ROOM_MAX) || newRoom(null); }
function dropRoomIfEmpty(r) {
  if (r.clients.size) return;
  if (!r.lobby && rooms.filter(x => !x.lobby).length <= 1) return; // jednu veřejnou arénu necháme
  rooms.splice(rooms.indexOf(r), 1); if (r.lobby) r.lobby.room = null;
  console.log(`arena #${r.id} closed`);
}
const totalPlayers = () => conns.size;

/* ---------- lobby ---------- */
const lobbies = new Map(); // kód → { code, leader, members: Set<conn>, room }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O a 1/I, ať se kód dobře přepisuje
function newCode() {
  let c; do { c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; } while (lobbies.has(c));
  return c;
}
function lobbyState(L, forConn) {
  return { t: 'lobby', code: L.code, max: LOBBY_MAX, members: [...L.members].map(c => ({
    name: c.name, inGame: c.inGame, leader: c === L.leader, me: c === forConn })) };
}
function broadcastLobby(L) { for (const c of L.members) c.send(lobbyState(L, c)); }
function leaveLobby(c) {
  const L = c.lobby; if (!L) return;
  L.members.delete(c); c.lobby = null;
  if (c.room && c.room.lobby === L) leaveRoom(c); // ze soukromé arény odejde taky
  if (!L.members.size) { lobbies.delete(L.code); console.log(`lobby ${L.code} closed`); return; }
  if (L.leader === c) L.leader = L.members.values().next().value;
  broadcastLobby(L);
}

/* ---------- připojení ---------- */
const conns = new Set();
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  r.world.removePlayer(c.pid); r.clients.delete(c.pid); c.room = null; c.pid = 0; c.inGame = false;
  dropRoomIfEmpty(r);
}
function cleanName(n) { return String(n || '').replace(/[<>]/g, '').trim().slice(0, 14) || 'Player'; }

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ players: totalPlayers(), lobbies: lobbies.size,
      rooms: rooms.map(r => ({ id: r.id, lobby: !!r.lobby, players: r.clients.size })) }));
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, f[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048,
  perMessageDeflate: { threshold: 512, clientNoContextTakeover: true } });
wss.on('error', err => console.warn('ws server error:', err.message));
server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) {} });
// Poslední pojistka: chybu zalogovat, ale hru nechat běžet dál
process.on('uncaughtException', err => console.error('uncaught:', err));

wss.on('connection', ws => {
  const c = { ws, name: 'Player', alive: true, room: null, pid: 0, lobby: null, inGame: false, msgs: 0, win: Date.now(),
    send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
  conns.add(c);
  c.send({ t: 'hi', n: totalPlayers() });

  ws.on('message', raw => {
    const now = Date.now(); if (now - c.win > 1000) { c.win = now; c.msgs = 0; }
    if (++c.msgs > 120) return; // jednoduchý limit proti spamu
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.name) c.name = cleanName(m.name);

    if (m.t === 'lobby') {
      if (m.a === 'create') {
        leaveLobby(c);
        const L = { code: newCode(), leader: c, members: new Set([c]), room: null };
        lobbies.set(L.code, L); c.lobby = L; console.log(`lobby ${L.code} created`);
        if (c.room) leaveRoom(c); // z veřejné arény odejde, hraje se v lobby
        broadcastLobby(L);
      } else if (m.a === 'join') {
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const L = lobbies.get(code);
        if (!L) return c.send({ t: 'lobbyErr', e: 'notFound', code });
        if (L === c.lobby) return broadcastLobby(L);
        if (L.members.size >= LOBBY_MAX) return c.send({ t: 'lobbyErr', e: 'full', code });
        leaveLobby(c); if (c.room) leaveRoom(c);
        L.members.add(c); c.lobby = L; broadcastLobby(L);
      } else if (m.a === 'leave') {
        leaveLobby(c); c.send({ t: 'lobby', code: null });
      }
    } else if (m.t === 'join') {
      // kdo je v lobby, hraje v jeho aréně; ostatní ve veřejné
      const target = c.lobby ? (c.lobby.room || (c.lobby.room = newRoom(c.lobby))) : (c.room && !c.room.lobby ? c.room : publicRoom());
      if (c.room && c.room !== target) leaveRoom(c);
      if (!c.room) { c.room = target; c.pid = target.world.addPlayer(c.name); target.clients.set(c.pid, c); }
      c.room.world.spawnPlayer(c.pid, { name: c.name, ci: m.ci | 0, skin: String(m.skin || '') });
      c.inGame = true; if (c.lobby) broadcastLobby(c.lobby);
    } else if (m.t === 'in' && c.room) {
      c.room.world.input(c.pid, { a: Number(m.a), b: !!m.b, u: m.u ? 1 : 0, q: Number(m.q), vw: Number(m.vw) || 1600, vh: Number(m.vh) || 1000 });
    } else if (m.t === 'p') {
      c.send({ t: 'p', c: m.c }); // ping pro měření odezvy
    } else if (m.t === 'name') {
      if (c.lobby) broadcastLobby(c.lobby);
    } else if (m.t === 'menu') {
      // hráč odešel z konce hry do menu: v lobby zůstává, jen už „nehraje“
      if (c.inGame) { c.inGame = false; if (c.lobby) broadcastLobby(c.lobby); }
    }
  });

  ws.on('pong', () => { c.alive = true; });
  // Poškozená nebo useknutá zpráva (typicky odpojení uprostřed přenosu) nesmí shodit server všem
  ws.on('error', err => { console.warn('client error:', err.code || err.message); try { ws.terminate(); } catch (e) {} });
  ws.on('close', () => { leaveLobby(c); leaveRoom(c); conns.delete(c); });
});

/* ---------- herní smyčka ---------- */
let last = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint(); acc += Number(now - last) / 1e9; last = now;
  if (acc > 0.25) acc = 0.25; // po zaseknutí nedohánět donekonečna
  while (acc >= TICK) {
    acc -= TICK;
    for (const r of rooms) {
      if (r.clients.size === 0) continue; // prázdná aréna spí
      r.world.step(TICK);
      if (++r.tick % SNAP_EVERY === 0) {
        const light = (r.tick / SNAP_EVERY) % FULL_EVERY !== 0;
        for (const [pid, c] of r.clients) {
          if (c.ws.readyState !== 1 || c.ws.bufferedAmount > 256 * 1024) continue; // pomalý klient: vynech snímek
          const s = r.world.snapshot(pid, light);
          if (s.dead && c.inGame) { c.inGame = false; if (c.lobby) broadcastLobby(c.lobby); }
          c.ws.send(JSON.stringify({ t: 's', ...s }));
        }
      }
    }
  }
}, 1000 / 60);

// Ping každých 25 s: udrží spojení přes proxy (Render) a odpojí "mrtvé" klienty
setInterval(() => {
  for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} }
}, 25000);

// lidem v menu občas pošli počet hráčů online
setInterval(() => { for (const c of conns) c.send({ t: 'hi', n: totalPlayers() }); }, 5000);

server.listen(PORT, () => console.log(`Coilcast running on http://localhost:${PORT}`));
