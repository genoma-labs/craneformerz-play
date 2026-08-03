// ─────────────────────────────────────────────────────────────────────────────
// Multiplayer client: lobby UI + WebSocket sync.
//
// Login is intentionally just a display name - no passwords, no accounts, no
// download. Type a name, join a room by code or QUICK JOIN, play. Anything more
// (persistent accounts, ranked) would need real auth and a database; this build
// is deliberately friction-free, and that limitation is stated rather than
// implied away.
// ─────────────────────────────────────────────────────────────────────────────

export const net = {
  ws: null, id: null, room: null, isHost: false,
  players: new Map(),        // id -> latest remote state
  connected: false,
  onJoined: null, onWorld: null,
  lastSend: 0,
};

const $ = id => document.getElementById(id);

// The published demo is on static hosting, which cannot serve WebSockets, so the
// room server lives on a Cloudflare Worker + Durable Object. Local dev still
// serves the game and the socket from one origin, so keep that path same-origin.
const ROOM_SERVER = 'wss://craneformerz-rooms.genoma-labs.workers.dev';
function wsUrl() {
  const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  if (local) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }
  return ROOM_SERVER;
}

export function connect() {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl());
    net.ws = ws;
    ws.onopen = () => { net.connected = true; resolve(true); };
    ws.onerror = () => { net.connected = false; resolve(false); };
    ws.onclose = () => {
      net.connected = false;
      setLobbyStatus('MULTIPLAYER NOT LIVE YET — SOLO VS AI IS READY', false);
      setMultiplayerAvailable(false);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case 'welcome': net.id = m.id; break;
        case 'rooms': renderRooms(m.rooms); break;
        case 'joined':
          net.room = m.room; net.isHost = m.isHost;
          net.players.clear();
          for (const p of m.players) if (p.id !== net.id) net.players.set(p.id, p);
          hideLobby();
          net.onJoined?.(m);
          break;
        case 'players':
          for (const p of m.players) {
            if (p.id === net.id) continue;
            net.players.set(p.id, p);
          }
          break;
        case 'player': net.players.set(m.player.id, m.player); break;
        case 'left': net.players.delete(m.id); break;
        case 'host': net.isHost = (m.hostId === net.id); break;
        case 'room': net.room = m.room; break;
        case 'world': if (!net.isHost) net.onWorld?.(m); break;
        case 'error': setLobbyStatus(m.message, true); break;
      }
    };
  });
}

export function sendState(s) {
  if (!net.connected || !net.room) return;
  const now = performance.now();
  if (now - net.lastSend < 50) return;      // 20 Hz
  net.lastSend = now;
  net.ws.send(JSON.stringify({ type: 'state', ...s }));
}

export function sendKill(wave) {
  if (!net.connected || !net.room) return;
  net.ws.send(JSON.stringify({ type: 'kill', wave }));
}

export function sendWorld(zombies, trucks) {
  if (!net.connected || !net.room || !net.isHost) return;
  net.ws.send(JSON.stringify({ type: 'world', zombies, trucks }));
}


// The demo is hosted on static hosting (GitHub Pages), which cannot serve
// WebSockets. Rather than leave QUICK JOIN / CREATE ROOM looking functional and
// failing silently, grey them out and say why. Solo play is unaffected.
function setMultiplayerAvailable(ok) {
  const ids = ['btnQuick', 'btnCreate', 'btnCode', 'roomCode'];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('mp-off', !ok);
    if ('disabled' in el) el.disabled = !ok;
    el.style.pointerEvents = ok ? '' : 'none';
    el.title = ok ? '' : 'Multiplayer server is not live yet';
  }
  const solo = $('btnSolo');
  if (solo) solo.classList.toggle('primary', !ok);
}

// ── Lobby UI ────────────────────────────────────────────────────────────────
function setLobbyStatus(text, isError) {
  const el = $('lobbyStatus');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff8a80' : 'rgba(255,255,255,.7)';
}

function renderRooms(list) {
  const box = $('roomList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="empty">' +
      (net.connected ? 'No open rooms — start one.'
                     : 'Rooms need a live game server, which is not up yet. SOLO VS AI plays now.') + '</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'roomrow';
    row.innerHTML = `<b>${r.code}</b><span>${r.count}/8 · wave ${r.wave}</span>`;
    row.onclick = () => joinRoom(r.code);
    box.appendChild(row);
  }
}

export function joinRoom(code, quick) {
  const name = ($('playerName')?.value || 'CRANE').trim() || 'CRANE';
  localStorage.setItem('cfz_name', name);
  if (!net.connected) { setLobbyStatus('NOT CONNECTED', true); return; }
  setLobbyStatus('JOINING…');
  net.ws.send(JSON.stringify({ type: 'join', name, code: code || null, quick: !!quick }));
}

function hideLobby() { const l = $('lobby'); if (l) l.style.display = 'none'; }

export async function initLobby(onSolo) {
  const saved = localStorage.getItem('cfz_name');
  if (saved && $('playerName')) $('playerName').value = saved;

  // Edition switch - reloads so the whole theme (meshes, voices, palette) rebuilds
  const cur = localStorage.getItem('cfz_edition') === 'S' ? 'S' : 'Z';
  const markEd = () => {
    $('edZ')?.classList.toggle('sel', cur === 'Z');
    $('edS')?.classList.toggle('sel', cur === 'S');
  };
  markEd();
  $('edZ').onclick = () => { if (cur !== 'Z') { localStorage.setItem('cfz_edition', 'Z'); location.search = '?mode=z'; } };
  $('edS').onclick = () => { if (cur !== 'S') { localStorage.setItem('cfz_edition', 'S'); location.search = '?mode=s'; } };

  $('btnSolo').onclick = () => { hideLobby(); onSolo(); };
  $('btnQuick').onclick = () => joinRoom(null, true);
  $('btnCreate').onclick = () => joinRoom(null, false);
  $('btnCode').onclick = () => {
    const c = ($('roomCode').value || '').trim().toUpperCase();
    if (c.length < 3) { setLobbyStatus('ENTER A ROOM CODE', true); return; }
    joinRoom(c);
  };

  setLobbyStatus('CONNECTING…');
  const ok = await connect();
  if (!ok) {
    setLobbyStatus('MULTIPLAYER NOT LIVE YET — SOLO VS AI IS READY', false);
    setMultiplayerAvailable(false);
    return;
  }
  setLobbyStatus('');
  setMultiplayerAvailable(true);
  net.ws.send(JSON.stringify({ type: 'list' }));
  setInterval(() => {
    if (net.connected && !net.room) net.ws.send(JSON.stringify({ type: 'list' }));
  }, 3000);
}
