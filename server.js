import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAP_IDS, VIS_IDS } from './public/maps.js';
import { COUNTDOWN_MS } from './public/shared.js';

const PORT = Number(process.env.PORT) || 3210;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

// ---------- Static file server ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

// ---------- Rooms: 2 players, one driver + one navigator ----------
// phase: 'lobby' → 'race' → 'results' → 'lobby'
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      players: [null, null],
      lobby: { map: MAP_IDS[0], vis: 'clear', roles: ['driver', 'passenger'] },
      phase: 'lobby',
      startAt: 0,
      results: null,
      paused: false, // shared pause: either player can pause/resume for both
      pausedBy: null,
      pauseAt: 0,
      pausedTotal: 0,
    };
    rooms.set(id, room);
  }
  return room;
}

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
const num = (v) => (Number.isFinite(v) ? v : 0);

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const roomId = (new URL(req.url, 'http://localhost').searchParams.get('room') || 'lobby').slice(0, 32);
  const room = getRoom(roomId);
  const slot = room.players.indexOf(null);
  if (slot === -1) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }

  room.players[slot] = ws;
  const other = () => room.players[1 - slot];
  const broadcast = (msg) => room.players.forEach((p) => send(p, msg));

  send(ws, {
    t: 'welcome',
    slot,
    peer: !!other(),
    lobby: room.lobby,
    phase: room.phase,
    elapsed: Date.now() - room.startAt - room.pausedTotal - (room.paused ? Date.now() - room.pauseAt : 0),
    paused: room.paused,
    pausedBy: room.pausedBy,
    results: room.results,
  });
  send(other(), { t: 'peer-joined' });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'state':
      case 'signal':
      case 'event':
        send(other(), msg); // relayed straight to the partner
        break;
      case 'set': {
        if (room.phase !== 'lobby') return;
        const { lobby } = room;
        if (msg.role === 'driver' || msg.role === 'passenger') {
          lobby.roles[slot] = msg.role;
          lobby.roles[1 - slot] = msg.role === 'driver' ? 'passenger' : 'driver';
        }
        if (MAP_IDS.includes(msg.map)) lobby.map = msg.map;
        if (VIS_IDS.includes(msg.vis)) lobby.vis = msg.vis;
        broadcast({ t: 'lobby', lobby, phase: room.phase });
        break;
      }
      case 'start':
      case 'restart':
        if (msg.t === 'start' ? room.phase !== 'lobby' : room.phase === 'lobby') return;
        room.phase = 'race';
        room.startAt = Date.now() + COUNTDOWN_MS;
        room.results = null;
        Object.assign(room, { paused: false, pausedBy: null, pausedTotal: 0 });
        broadcast({ t: 'start', lobby: room.lobby, delay: COUNTDOWN_MS });
        break;
      case 'pause': {
        if (room.phase !== 'race' || !!msg.on === room.paused) return;
        room.paused = !!msg.on;
        if (room.paused) {
          room.pauseAt = Date.now();
          room.pausedBy = room.lobby.roles[slot];
        } else {
          room.pausedTotal += Date.now() - room.pauseAt;
        }
        broadcast({ t: 'pause', on: room.paused, by: room.pausedBy });
        break;
      }
      case 'finish':
        if (room.phase !== 'race' || room.lobby.roles[slot] !== 'driver') return;
        room.phase = 'results';
        room.results = {
          time: num(msg.time),
          pen: num(msg.pen),
          wrong: num(msg.wrong),
          resets: num(msg.resets),
          splits: Array.isArray(msg.splits) ? msg.splits.slice(0, 4).map(num) : [],
        };
        broadcast({ t: 'results', results: room.results });
        break;
      case 'to-lobby':
        room.phase = 'lobby';
        room.paused = false;
        broadcast({ t: 'lobby', lobby: room.lobby, phase: room.phase });
        break;
    }
  });

  ws.on('close', () => {
    room.players[slot] = null;
    send(other(), { t: 'peer-left' });
    if (!room.players[0] && !room.players[1]) rooms.delete(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Two Lane running at http://localhost:${PORT}`);
});
