const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// Board constants (same geometry as the client)
const START = { red: 0, blue: 13, yellow: 26, green: 39 };
const SAFE = new Set(Object.values(START));
const LAYOUT = { 2: ['red', 'yellow'], 3: ['red', 'blue', 'yellow'], 4: ['red', 'blue', 'yellow', 'green'] };
const rooms = {};

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 5 }, () => chars[(Math.random() * chars.length) | 0]).join(''); } while (rooms[s]);
  return s;
}
const cur = (r) => r.players[r.turn];

function pub(r) {
  return {
    code: r.code, phase: r.phase, hostId: r.host, turn: r.turn, dice: r.dice,
    tokens: r.tokens, movable: r.movable, winner: r.winner,
    players: r.players.map((p) => ({ id: p.id, name: p.name, color: p.color, online: p.online })),
  };
}
const send = (r, anim) => io.to(r.code).emit('update', { state: pub(r), anim });

function legal(r, color, d) {
  const out = [];
  r.tokens[color].forEach((s, id) => {
    if (s === -1) { if (d === 6) out.push({ id, from: -1, to: 0 }); }
    else if (s < 57 && s + d <= 57) out.push({ id, from: s, to: s + d });
  });
  return out;
}

function botCheck(r) {
  if (r.phase !== 'roll' || !cur(r) || cur(r).online) return;
  const t = r.turn;
  // give a disconnected player 8s to come back before a bot rolls for them
  setTimeout(() => { if (r.phase === 'roll' && r.turn === t && cur(r) && !cur(r).online) doRoll(r); }, 8000);
}

function nextTurn(r, again) {
  if (!again) r.turn = (r.turn + 1) % r.players.length;
  r.phase = 'roll'; r.dice = 0; r.movable = [];
  send(r, null);
  botCheck(r);
}

function doRoll(r) {
  if (r.phase !== 'roll') return;
  const p = cur(r);
  const v = 1 + ((Math.random() * 6) | 0);
  const seq = ++r.seq;
  r.dice = v;
  r.movable = legal(r, p.color, v);
  if (!r.movable.length) {
    r.phase = 'busy';
    send(r, { type: 'roll', color: p.color, value: v, stop: true });
    setTimeout(() => nextTurn(r, false), 2600);
    return;
  }
  r.phase = 'move';
  send(r, { type: 'roll', color: p.color, value: v });
  if (r.movable.length === 1 || !p.online) {
    const pick = r.movable[(Math.random() * r.movable.length) | 0].id;
    setTimeout(() => doMove(r, pick, seq), 1900);
  }
}

function doMove(r, id, seq) {
  if (r.phase !== 'move' || (seq !== undefined && seq !== r.seq)) return;
  const m = r.movable.find((x) => x.id === id);
  if (!m) return;
  const c = cur(r).color;
  r.tokens[c][id] = m.to;
  const cap = [];
  if (m.to >= 0 && m.to <= 50) {
    const abs = (START[c] + m.to) % 52;
    if (!SAFE.has(abs)) {
      for (const o of r.players) {
        if (o.color === c) continue;
        r.tokens[o.color].forEach((s, i) => {
          if (s >= 0 && s <= 50 && (START[o.color] + s) % 52 === abs) { r.tokens[o.color][i] = -1; cap.push({ color: o.color, id: i }); }
        });
      }
    }
  }
  const anim = { type: 'move', color: c, id, from: m.from, to: m.to, cap };
  r.movable = [];
  if (r.tokens[c].every((s) => s === 57)) { r.phase = 'over'; r.winner = c; send(r, anim); return; }
  const again = r.dice === 6 || cap.length > 0 || m.to === 57;
  r.phase = 'busy';
  send(r, anim);
  const wait = Math.max(1, m.to - m.from) * 190 + (cap.length ? 900 : 500);
  setTimeout(() => nextTurn(r, again), wait);
}

io.on('connection', (s) => {
  const room = () => rooms[s.data.room];
  const me = (r) => r && r.players.find((p) => p.id === s.id);

  function enter(r, name, key) {
    r.players.push({ key, id: s.id, name: (name || 'Player').trim().slice(0, 14) || 'Player', color: null, online: true });
    s.join(r.code); s.data.room = r.code;
    send(r, null);
  }

  s.on('create', (name, key, cb) => {
    const code = newCode();
    const r = (rooms[code] = { code, phase: 'lobby', host: s.id, players: [], turn: 0, dice: 0, tokens: {}, movable: [], winner: null, seq: 0 });
    enter(r, name, key);
    cb({ ok: true, code });
  });

  s.on('join', (code, name, key, cb) => {
    const r = rooms[String(code || '').toUpperCase()];
    if (!r) return cb({ err: 'Room not found' });
    const nm = (name || 'Player').trim().slice(0, 14);
    const back = key && r.players.find((p) => p.key === key);
    if (back) { // reconnect to a running game
      if (r.host === back.id) r.host = s.id;
      back.id = s.id; back.online = true; s.join(r.code); s.data.room = r.code; send(r, null);
      return cb({ ok: true, code: r.code });
    }
    if (r.phase !== 'lobby') return cb({ err: 'Game already started' });
    if (r.players.length >= 4) return cb({ err: 'Room is full (max 4)' });
    enter(r, nm, key);
    cb({ ok: true, code: r.code });
  });

  s.on('start', () => {
    const r = room();
    if (!r || r.host !== s.id || r.phase !== 'lobby' || r.players.length < 2) return;
    const cols = LAYOUT[r.players.length];
    r.players.forEach((p, i) => { p.color = cols[i]; r.tokens[p.color] = [-1, -1, -1, -1]; });
    r.turn = 0; r.phase = 'roll'; r.dice = 0; r.winner = null;
    send(r, null);
  });

  s.on('roll', () => { const r = room(); if (r && cur(r) && cur(r).id === s.id) doRoll(r); });
  s.on('move', (id) => { const r = room(); if (r && cur(r) && cur(r).id === s.id) doMove(r, id); });

  s.on('again', () => {
    const r = room();
    if (!r || r.host !== s.id || r.phase !== 'over') return;
    r.players = r.players.filter((p) => p.online);
    r.players.forEach((p) => (p.color = null));
    Object.assign(r, { phase: 'lobby', tokens: {}, movable: [], winner: null, dice: 0, turn: 0 });
    send(r, null);
  });

  s.on('chat', (text) => {
    const r = room();
    const p = me(r);
    if (!r || !p) return;
    text = String(text || '').trim().slice(0, 300);
    if (!text) return;
    io.to(r.code).emit('chat', { name: p.name, color: p.color, id: p.id, text, ts: Date.now() });
  });

  s.on('voice-on', (cb) => {
    const r = room();
    const p = me(r);
    if (!r || !p) return;
    r.voice = r.voice || new Set();
    r.voice.add(s.id);
    const others = [...r.voice].filter((id) => id !== s.id).map((id) => ({ id, name: (r.players.find((x) => x.id === id) || {}).name }));
    if (cb) cb(others);
    s.to(r.code).emit('voice-on', { id: s.id, name: p.name });
  });

  s.on('voice-off', () => {
    const r = room();
    if (!r || !r.voice) return;
    r.voice.delete(s.id);
    s.to(r.code).emit('voice-off', { id: s.id });
  });

  s.on('rtc-signal', ({ to, data }) => { io.to(to).emit('rtc-signal', { from: s.id, data }); });

  s.on('disconnect', () => {
    const r = room();
    const p = me(r);
    if (!p) return;
    if (r.voice && r.voice.has(s.id)) { r.voice.delete(s.id); s.to(r.code).emit('voice-off', { id: s.id }); }
    p.online = false;
    if (r.phase === 'lobby') {
      r.players = r.players.filter((x) => x !== p);
      if (r.host === s.id && r.players[0]) r.host = r.players[0].id;
    }
    if (!r.players.some((x) => x.online)) { delete rooms[r.code]; return; }
    send(r, null);
    botCheck(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ludo running on http://localhost:' + PORT));
