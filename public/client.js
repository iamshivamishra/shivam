const socket = io();
const KEY = localStorage.getItem('ludoKey') || (Date.now().toString(36) + Math.random().toString(36).slice(2));
localStorage.setItem('ludoKey', KEY);
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- board geometry ---------- */
const COL = { red: '#e5202c', blue: '#1673e6', yellow: '#f6c319', green: '#19a34a' };
const ORDER = ['red', 'blue', 'yellow', 'green'];
const START = { red: 0, blue: 13, yellow: 26, green: 39 };
const arm0 = [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8]];
const rot = (p) => [p[1], 14 - p[0]];
let path = [], cur = arm0;
for (let i = 0; i < 4; i++) { path = path.concat(cur); cur = cur.map(rot); }
const HOME = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  blue:   [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  green:  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};
const CARD = { red: [7, 7], blue: [66, 7], yellow: [66, 66], green: [7, 66] }; // % (card is 27% wide)

// returns [leftPct, topPct] of a token
function pos(color, steps, id) {
  if (steps === -1) {
    const [x, y] = CARD[color];
    return [x + 27 * (id % 2 ? 0.62 : 0.22), y + 27 * (id < 2 ? 0.22 : 0.62)];
  }
  const cell = steps <= 50 ? path[(START[color] + steps) % 52] : steps <= 56 ? HOME[color][steps - 51] : [7, 7];
  return [(cell[1] * 100) / 15 + 0.13, (cell[0] * 100) / 15 + 0.13];
}

/* ---------- state ---------- */
let S = null, built = false, disp = {}, els = {};
let queue = Promise.resolve();

/* ---------- dice ---------- */
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const FACE_ROT = { 1: [0, 0], 6: [0, 180], 2: [0, -90], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };
let bx = 0, by = 0;
(function buildCube() {
  for (let v = 1; v <= 6; v++) {
    const f = document.createElement('div');
    f.className = 'face f' + v;
    for (let i = 1; i <= 9; i++) {
      const c = document.createElement('div');
      if (PIPS[v].includes(i)) c.appendChild(document.createElement('b'));
      f.appendChild(c);
    }
    $('cube').appendChild(f);
  }
})();
async function rollDice(v) {
  const [tx, ty] = FACE_ROT[v];
  bx += 1080; by += 1080;
  $('cube').style.transform = `rotateX(${bx + tx}deg) rotateY(${by + ty}deg)`;
  $('scene').animate([{ translate: '0 0' }, { translate: '0 -40px' }, { translate: '0 0' }, { translate: '0 -14px' }, { translate: '0 0' }], { duration: 1000 });
  await sleep(1050);
}

/* ---------- screens ---------- */
let lastRoomForChat = null;
function show(id) {
  for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== id);
  setChatVisible(id === 'lobby' || id === 'game');
  if (typeof setVoiceVisible === 'function') setVoiceVisible(id === 'lobby' || id === 'game');
  if (id === 'home') {
    lastRoomForChat = null;
    if (typeof micOn !== 'undefined' && micOn) $('micBtn') && $('micBtn').click();
  }
}
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();
$('name').value = localStorage.getItem('ludoName') || '';

function go(ev, ...args) {
  const name = $('name').value.trim();
  if (!name) { $('err').textContent = 'Please enter your name'; return; }
  localStorage.setItem('ludoName', name);
  socket.emit(ev, ...args.map((a) => (a === '$name' ? name : a)), KEY, (res) => { if (res.err) $('err').textContent = res.err; });
}
$('create').onclick = () => go('create', '$name');
$('join').onclick = () => { const n = $('name').value.trim(); if (!n) { $('err').textContent = 'Please enter your name'; return; } localStorage.setItem('ludoName', n); socket.emit('join', $('code').value.trim(), n, KEY, (res) => { if (res.err) $('err').textContent = res.err; }); };

// auto-rejoin after refresh / network drop (new socket id => server rebinds us by KEY)
socket.on('connect', () => {
  const room = sessionStorage.getItem('ludoRoom'), name = localStorage.getItem('ludoName');
  if (room && name) socket.emit('join', room, name, KEY, (res) => { if (res.err) { sessionStorage.removeItem('ludoRoom'); S = null; built = false; show('home'); } });
});
$('start').onclick = () => socket.emit('start');
$('again').onclick = () => socket.emit('again');
$('copy').onclick = () => {
  const link = location.origin + '/?room=' + S.code;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => ($('copy').textContent = 'Copied ✓'), () => prompt('Copy this link', link));
  setTimeout(() => ($('copy').textContent = 'Copy invite link'), 1500);
};
const tryRoll = () => { if (myTurn() && S.phase === 'roll') socket.emit('roll'); };
$('scene').onclick = tryRoll;
$('rollBtn').onclick = tryRoll;

const myTurn = () => S && S.players[S.turn] && S.players[S.turn].id === socket.id;

/* ---------- board build ---------- */
function buildBoard() {
  const b = $('board');
  b.innerHTML = '';
  const pos4 = { red: 'top:0;left:0', blue: 'top:0;right:0', yellow: 'bottom:0;right:0', green: 'bottom:0;left:0' };
  ORDER.forEach((c) => {
    const base = document.createElement('div');
    base.className = 'base'; base.style.cssText = pos4[c] + ';background:' + COL[c];
    b.appendChild(base);
    const [x, y] = CARD[c];
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'card-' + c;
    card.style.left = x + '%'; card.style.top = y + '%';
    b.appendChild(card);
    const nm = document.createElement('div');
    nm.className = 'pname'; nm.id = 'pname-' + c;
    nm.style.left = x + '%'; nm.style.top = (y < 50 ? 1.6 : 94.4) + '%';
    b.appendChild(nm);
  });
  path.forEach((cell, idx) => {
    const d = document.createElement('div');
    d.className = 'cell';
    d.style.left = (cell[1] * 100) / 15 + '%'; d.style.top = (cell[0] * 100) / 15 + '%';
    ORDER.forEach((c) => { if (((idx - START[c] + 52) % 52) < 5) d.style.background = COL[c]; });
    if (Object.values(START).includes(idx)) d.classList.add('star');
    b.appendChild(d);
  });
  ORDER.forEach((c) => HOME[c].forEach((cell) => {
    const d = document.createElement('div');
    d.className = 'cell';
    d.style.left = (cell[1] * 100) / 15 + '%'; d.style.top = (cell[0] * 100) / 15 + '%'; d.style.background = COL[c];
    b.appendChild(d);
  }));
  const ctr = document.createElement('div');
  ctr.className = 'center';
  [['t', 'blue'], ['r', 'yellow'], ['b', 'green'], ['l', 'red']].forEach(([k, c]) => {
    const t = document.createElement('div'); t.className = 'tri ' + k; t.style.background = COL[c]; ctr.appendChild(t);
  });
  b.appendChild(ctr);
  const ban = document.createElement('div');
  ban.className = 'banner'; ban.id = 'banner'; ban.innerHTML = '<span>STOP</span>';
  b.appendChild(ban);

  els = {}; disp = {};
  S.players.forEach((p) => {
    disp[p.color] = [...S.tokens[p.color]]; els[p.color] = [];
    for (let i = 0; i < 4; i++) {
      const t = document.createElement('div');
      t.className = 'token'; t.style.setProperty('--c', COL[p.color]);
      t.innerHTML = '<i></i>';
      t.onclick = () => { if (myTurn() && S.phase === 'move' && S.movable.some((m) => m.id === i) && S.players[S.turn].color === p.color) socket.emit('move', i); };
      b.appendChild(t); els[p.color].push(t);
    }
  });
  S.players.forEach((p) => ($('pname-' + p.color).textContent = p.name + (p.id === socket.id ? ' (you)' : '')));
  built = true;
  layout();
}

function layout() {
  const groups = {};
  for (const c in disp) disp[c].forEach((s, i) => { const p = pos(c, s, i); (groups[s === -1 ? c + i : p.join()] ||= []).push([c, i, p]); });
  for (const g of Object.values(groups)) {
    g.forEach(([c, i, p], k) => {
      const o = g.length > 1 ? (k - (g.length - 1) / 2) * 1.5 : 0;
      const el = els[c][i];
      el.style.left = p[0] + o + '%'; el.style.top = p[1] + '%';
      el.style.transform = g.length > 1 ? 'scale(.78)' : 'scale(1)';
    });
  }
}

/* ---------- UI refresh ---------- */
function refreshUI() {
  const s = S, p = s.players[s.turn];
  if (!p) return;
  $('turnPill').innerHTML = `<span class="dot" style="background:${COL[p.color]}"></span>${p.name}${p.id === socket.id ? ' (you)' : ''}${p.online ? '' : ' 🤖'}`;
  ORDER.forEach((c) => $('card-' + c) && $('card-' + c).classList.toggle('active', c === p.color && s.phase !== 'over'));
  const mine = myTurn();
  $('scene').classList.toggle('ready', mine && s.phase === 'roll');
  $('rollBtn').disabled = !(mine && s.phase === 'roll');
  $('msg').textContent = s.phase === 'over' ? `🏆 ${s.players.find((x) => x.color === s.winner).name} wins!`
    : mine && s.phase === 'roll' ? 'Your turn — tap the dice!'
    : mine && s.phase === 'move' ? `You rolled ${s.dice} — tap a glowing token`
    : s.dice ? `${p.name} rolled ${s.dice}`
    : `${p.name}'s turn…`;
  for (const c in els) els[c].forEach((el, i) => el.classList.toggle('movable', mine && s.phase === 'move' && p.color === c && s.movable.some((m) => m.id === i)));
  $('again').classList.toggle('hidden', !(s.phase === 'over' && s.hostId === socket.id));
  $('gcode').textContent = 'Room ' + s.code;
}

function renderLobby() {
  $('roomCode').textContent = S.code;
  $('plist').innerHTML = S.players.map((p) => `<li><span>${p.name.replace(/</g, '&lt;')}${p.id === socket.id ? ' (you)' : ''}</span><span>${p.id === S.hostId ? '👑 host' : ''}</span></li>`).join('');
  const host = S.hostId === socket.id;
  $('start').classList.toggle('hidden', !host);
  $('start').disabled = S.players.length < 2;
  $('lobbyMsg').textContent = S.players.length < 2 ? 'Waiting for players… share the code (2–4 players)' : host ? 'Ready when you are!' : 'Waiting for host to start…';
}

/* ---------- animations ---------- */
function bounce(el) {
  el.firstChild.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-55%) scale(1.3)' }, { transform: 'translateY(0) scale(1)' }], { duration: 170 });
}
async function playMove(a) {
  const el = els[a.color][a.id];
  el.style.zIndex = 20;
  if (disp[a.color][a.id] === -1) { disp[a.color][a.id] = 0; layout(); bounce(el); await sleep(260); }
  else for (let s = disp[a.color][a.id] + 1; s <= a.to; s++) { disp[a.color][a.id] = s; layout(); bounce(el); await sleep(185); }
  el.style.zIndex = '';
  if (a.cap && a.cap.length) {
    await sleep(120);
    a.cap.forEach((c) => { const e = els[c.color][c.id]; e.classList.add('fly'); disp[c.color][c.id] = -1; });
    layout();
    await sleep(760);
    a.cap.forEach((c) => els[c.color][c.id].classList.remove('fly'));
  }
}
async function flashStop() {
  const b = $('banner'); b.classList.add('show'); await sleep(1100); b.classList.remove('show');
}

async function handle({ state, anim }) {
  const wasLobby = !S || S.phase === 'lobby';
  S = state;
  sessionStorage.setItem('ludoRoom', S.code);
  if (lastRoomForChat !== S.code) { lastRoomForChat = S.code; $('chatMsgs').innerHTML = ''; unread = 0; $('chatBadge').classList.add('hidden'); }
  if (S.phase === 'lobby') { built = false; show('lobby'); renderLobby(); return; }
  if (!built) { show('game'); buildBoard(); }
  else if (wasLobby) { show('game'); }
  const real = state.movable;
  if (anim && anim.type === 'roll') {
    S.movable = []; refreshUI(); $('msg').textContent = 'Rolling…';
    await rollDice(anim.value);
    if (anim.stop) await flashStop();
    S.movable = real;
  } else if (anim && anim.type === 'move') {
    S.movable = []; refreshUI();
    await playMove(anim);
  } else {
    for (const c in disp) disp[c] = [...S.tokens[c]];
    layout();
  }
  refreshUI();
}

socket.on('update', (d) => { queue = queue.then(() => handle(d)).catch(console.error); });

/* ---------- chat ---------- */
let chatOpen = false, unread = 0;
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function addMsg({ name, color, id, text, sys }) {
  const row = document.createElement('div');
  row.className = 'msgRow' + (sys ? ' sys' : id === socket.id ? ' me' : '');
  const who = sys ? '' : `<div class="who" style="color:${COL[color] || '#fff'}">${escapeHtml(name)}</div>`;
  row.innerHTML = `${who}<div class="bubble">${escapeHtml(text)}</div>`;
  $('chatMsgs').appendChild(row);
  $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
  if (!sys && !chatOpen && id !== socket.id) { unread++; $('chatBadge').textContent = unread; $('chatBadge').classList.remove('hidden'); }
}
function setChatVisible(v) {
  $('chatToggle').classList.toggle('hidden', !v);
  if (!v) $('chatPanel').classList.add('hidden');
}
$('chatToggle').onclick = () => {
  chatOpen = !chatOpen;
  $('chatPanel').classList.toggle('hidden', !chatOpen);
  if (chatOpen) { unread = 0; $('chatBadge').classList.add('hidden'); $('chatInput').focus(); $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight; }
};
$('chatClose').onclick = () => { chatOpen = false; $('chatPanel').classList.add('hidden'); };
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('chatInput').value.trim();
  if (!v) return;
  socket.emit('chat', v);
  $('chatInput').value = '';
};
socket.on('chat', (m) => addMsg(m));

/* ---------- voice chat (WebRTC mesh, signaled over socket.io) ---------- */
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let localStream = null, micOn = false, speakerOn = true;
const rtcPeers = {}, rtcAudio = {}, voiceNames = {};

function setVoiceVisible(v) { $('voiceBar').classList.toggle('hidden', !v); if (!v) $('voiceNote').classList.add('hidden'); }
function note(t) { $('voiceNote').textContent = t; $('voiceNote').classList.remove('hidden'); clearTimeout(note._t); note._t = setTimeout(() => $('voiceNote').classList.add('hidden'), 2600); }

function closePeer(id) {
  if (rtcPeers[id]) { rtcPeers[id].close(); delete rtcPeers[id]; }
  if (rtcAudio[id]) { rtcAudio[id].srcObject = null; rtcAudio[id].remove(); delete rtcAudio[id]; }
}

function ensurePeer(id, offering) {
  if (rtcPeers[id]) return rtcPeers[id];
  const pc = new RTCPeerConnection({ iceServers: ICE });
  rtcPeers[id] = pc;
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('rtc-signal', { to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    let a = rtcAudio[id];
    if (!a) { a = new Audio(); a.autoplay = true; a.muted = !speakerOn; rtcAudio[id] = a; document.body.appendChild(a); }
    a.srcObject = e.streams[0];
  };
  if (offering) {
    pc.onnegotiationneeded = async () => {
      try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('rtc-signal', { to: id, data: { sdp: pc.localDescription } }); }
      catch (err) { console.error(err); }
    };
  }
  return pc;
}

socket.on('voice-on', ({ id, name }) => {
  voiceNames[id] = name;
  if (micOn) ensurePeer(id, socket.id < id);
});
socket.on('voice-off', ({ id }) => { delete voiceNames[id]; closePeer(id); });
socket.on('rtc-signal', async ({ from, data }) => {
  const pc = ensurePeer(from, false);
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
        socket.emit('rtc-signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) { console.error(err); }
});

function updateMicBtn() { $('micBtn').classList.toggle('off', !micOn); }
function updateSpeakerBtn() { $('speakerBtn').classList.toggle('off', !speakerOn); }

$('micBtn').onclick = async () => {
  if (!micOn) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { note('Voice not supported in this browser'); return; }
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { note('Microphone access denied'); return; }
    micOn = true; updateMicBtn();
    socket.emit('voice-on', (others) => {
      (others || []).forEach((o) => { voiceNames[o.id] = o.name; ensurePeer(o.id, socket.id < o.id); });
    });
    note('Mic on — others in this room can hear you');
  } else {
    micOn = false; updateMicBtn();
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    Object.keys(rtcPeers).forEach(closePeer);
    socket.emit('voice-off');
    note('Mic off');
  }
};
$('speakerBtn').onclick = () => {
  speakerOn = !speakerOn; updateSpeakerBtn();
  Object.values(rtcAudio).forEach((a) => (a.muted = !speakerOn));
  note(speakerOn ? 'Speaker on' : 'Speaker muted');
};
updateMicBtn(); updateSpeakerBtn();
