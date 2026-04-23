// ═══════════════════════════════════════════════════════════════
//  RETRO RACER — Multiplayer Relay Server
//  Node.js + ws  (npm install ws)
//  Run with:  node server.js
//  Then open your game at http://localhost:3000
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Static file server (serves your retro-racer HTML file) ──────
const os = require('os');

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'unknown';
}

const httpServer = http.createServer((req, res) => {
  // Return local IP as JSON
  if (req.url === '/myip') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ ip: getLocalIP(), port: PORT }));
    return;
  }
  // Serve the game HTML at /
  const filePath = path.join(__dirname, req.url === '/' ? 'retro-racer-multi.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200);
    res.end(data);
  });
});

// ── WebSocket server (multiplayer relay) ────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// Rooms: Map<roomCode, { players: Map<id, ws>, hostId, level, state }>
const rooms = new Map();

function makeRoomCode() {
  // 4-letter uppercase code e.g. "KART"
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function broadcast(room, message, excludeId = null) {
  // Send a message to every player in the room except the excluded one
  for (const [id, ws] of room.players) {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function broadcastRoomState(room, roomCode) {
  // Tell everyone who's in the lobby right now
  const playerList = [...room.players.keys()].map(id => ({
    id,
    name: room.meta[id]?.name || 'DRIVER',
    isHost: id === room.hostId,
    ready: room.meta[id]?.ready || false,
  }));
  broadcast(room, { type: 'lobby_update', players: playerList, roomCode });
  // Also send back to everyone including sender — simpler to just re-broadcast all
  for (const [id, ws] of room.players) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'lobby_update', players: playerList, roomCode, yourId: id }));
    }
  }
}

wss.on('connection', (ws) => {
  let playerId  = null;   // This socket's player ID
  let roomCode  = null;   // Which room this socket is in

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── HOST: create a new room ───────────────────────────────
    if (msg.type === 'host') {
      roomCode  = makeRoomCode();
      playerId  = 'p1';
      rooms.set(roomCode, {
        players: new Map([[playerId, ws]]),
        meta:    { [playerId]: { name: msg.name || 'DRIVER 1', ready: false } },
        hostId:  playerId,
        state:   'lobby',  // lobby → racing → finished
        level:   null,
      });
      ws.send(JSON.stringify({ type: 'hosted', roomCode, yourId: playerId }));
      console.log(`Room ${roomCode} created by ${playerId}`);
    }

    // ── JOIN: enter an existing room ──────────────────────────
    else if (msg.type === 'join') {
      const room = rooms.get(msg.roomCode?.toUpperCase());
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', text: 'Room not found' }));
        return;
      }
      if (room.players.size >= 4) {
        ws.send(JSON.stringify({ type: 'error', text: 'Room is full (max 4)' }));
        return;
      }
      if (room.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', text: 'Race already in progress' }));
        return;
      }
      roomCode = msg.roomCode.toUpperCase();
      playerId = 'p' + (room.players.size + 1);
      room.players.set(playerId, ws);
      room.meta[playerId] = { name: msg.name || `DRIVER ${room.players.size}`, ready: false };
      ws.send(JSON.stringify({ type: 'joined', roomCode, yourId: playerId }));
      broadcastRoomState(room, roomCode);
      console.log(`${playerId} joined room ${roomCode}`);
    }

    // ── READY: player signals they're ready to race ───────────
    else if (msg.type === 'ready') {
      const room = rooms.get(roomCode);
      if (!room) return;
      room.meta[playerId].ready = true;
      broadcastRoomState(room, roomCode);

      // If ALL players are ready, host triggers countdown
      const allReady = [...room.players.keys()].every(id => room.meta[id].ready);
      if (allReady && room.players.size >= 2) {
        room.state = 'racing';
        // Assign starting grid slots to each player
        const slots = [...room.players.keys()].map((id, i) => ({ id, slot: i }));
        broadcast(room, { type: 'race_start', level: msg.level, slots });
        for (const [id, ws] of room.players) {
          ws.send(JSON.stringify({ type: 'race_start', level: msg.level, slots, yourId: id }));
        }
        console.log(`Room ${roomCode} race started on level ${msg.level}`);
      }
    }

    // ── STATE UPDATE: player broadcasts their car position each frame ──
    //    This is the hot path — keep it lean, just relay to others
    else if (msg.type === 'state') {
      const room = rooms.get(roomCode);
      if (!room) return;
      // Attach sender's ID, relay to everyone else
      broadcast(room, {
        type:   'state',
        id:     playerId,
        x:      msg.x,
        y:      msg.y,
        angle:  msg.angle,
        speed:  msg.speed,
        lap:    msg.lap,
        skid:   msg.skid,   // bool: are they skidding? (for visual effect)
      }, playerId);          // excludeId = own id (don't echo back to sender)
    }

    // ── RACE EVENT: lap completion, finish, collision ─────────
    else if (msg.type === 'event') {
      const room = rooms.get(roomCode);
      if (!room) return;
      broadcast(room, { type: 'event', id: playerId, event: msg.event, data: msg.data }, playerId);
    }

    // ── CHAT: simple text message in lobby ────────────────────
    else if (msg.type === 'chat') {
      const room = rooms.get(roomCode);
      if (!room) return;
      const name = room.meta[playerId]?.name || playerId;
      broadcast(room, { type: 'chat', from: name, text: msg.text.slice(0, 120) });
    }
  });

  // ── DISCONNECT: clean up the room ────────────────────────────
  ws.on('close', () => {
    if (!roomCode || !playerId) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    delete room.meta[playerId];
    console.log(`${playerId} left room ${roomCode} (${room.players.size} remaining)`);

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} closed`);
    } else {
      // If host left, promote next player
      if (room.hostId === playerId) {
        room.hostId = room.players.keys().next().value;
      }
      broadcast(room, { type: 'player_left', id: playerId });
      broadcastRoomState(room, roomCode);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   RETRO RACER  —  SERVER READY   ║
  ║   http://localhost:${PORT}           ║
  ╚══════════════════════════════════╝
  `);
});
