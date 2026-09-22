// Einstiegspunkt: Menue, Lobby, Spielschleife, Vorhersage, Ereignisse.

import * as C from '/shared/constants.js';
import { stepMovement } from '/shared/physics.js';
import { deserializeMap } from '/shared/map.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';

const $ = (id) => document.getElementById(id);

const ui = {
  menu: $('menu'), lobby: $('lobby'), name: $('name'), code: $('code'), menuError: $('menu-error'),
  btnQuick: $('btn-quick'), btnCreate: $('btn-create'), btnJoin: $('btn-join'),
  lobbyCode: $('lobby-code'), invite: $('invite'), btnCopy: $('btn-copy'), lobbyPlayers: $('lobby-players'),
  lobbyHint: $('lobby-hint'), btnReady: $('btn-ready'), btnStart: $('btn-start'), btnLeave: $('btn-leave'),
  disconnected: $('disconnected'), discReason: $('disc-reason'), btnReload: $('btn-reload'), chatInput: $('chat-input'),
  lowfx: $('lowfx'),
};

const renderer = new Renderer($('game'), $('labels'));
const input = new Input(renderer.renderer.domElement);
const audio = new Audio();
const hud = new Hud();
let net = null;

const S = {
  meId: null, name: '', room: null, hostId: null, map: null,
  state: null,            // letzter Server-Snapshot
  stateAt: 0,
  you: null,
  pred: null,             // vorhergesagte eigene Position
  seq: 0,
  lastSend: 0,
  ready: false,
  phase: C.PHASE_LOBBY,
  inGame: false,
  lastPhaseSeen: null,
  lastTickSound: -1,
};

// ---------------------------------------------------------------- Menue
ui.name.value = localStorage.getItem('cc-name') ?? '';
ui.lowfx.checked = localStorage.getItem('cc-lowfx') === '1';
ui.lowfx.onchange = () => { localStorage.setItem('cc-lowfx', ui.lowfx.checked ? '1' : '0'); renderer.setLowFx(ui.lowfx.checked); };
const urlRoom = new URLSearchParams(location.search).get('raum');
if (urlRoom) ui.code.value = urlRoom.toUpperCase().slice(0, C.ROOM_CODE_LEN);

function showError(msg) { ui.menuError.textContent = msg; ui.menuError.hidden = !msg; }

function start(mode) {
  const name = ui.name.value.trim().slice(0, C.NAME_MAX);
  localStorage.setItem('cc-name', name);
  const room = ui.code.value.trim().toUpperCase();
  if (mode === 'join' && room.length !== C.ROOM_CODE_LEN) { showError('Bitte einen 4-stelligen Raumcode eingeben.'); return; }
  showError('');
  audio.unlock();
  setButtons(false);
  connect({ mode, name, room, public: false });
}

function setButtons(on) { for (const b of [ui.btnQuick, ui.btnCreate, ui.btnJoin]) b.disabled = !on; }

ui.btnQuick.onclick = () => start('quick');
ui.btnCreate.onclick = () => start('create');
ui.btnJoin.onclick = () => start('join');
ui.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') start('join'); });
ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(urlRoom ? 'join' : 'quick'); });
ui.btnReload.onclick = () => location.reload();

// ---------------------------------------------------------------- Lobby
ui.btnReady.onclick = () => {
  S.ready = !S.ready;
  net?.send({ t: 'ready', ready: S.ready });
  ui.btnReady.textContent = S.ready ? 'Bereit ✓' : 'Bereit';
  ui.btnReady.classList.toggle('on', S.ready);
};
ui.btnStart.onclick = () => net?.send({ t: 'start' });
ui.btnLeave.onclick = () => location.href = location.pathname;
ui.lobbyCode.onclick = () => copy(S.room);
ui.btnCopy.onclick = () => copy(inviteUrl());
function inviteUrl() { return `${location.origin}${location.pathname}?raum=${S.room}`; }
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => hud.feed('Kopiert: ' + text, 'good')).catch(() => {});
}

function renderLobby(msg) {
  hud.lastLobby = msg;
  S.hostId = msg.hostId;
  ui.lobbyCode.textContent = S.room ?? '----';
  ui.invite.textContent = inviteUrl();
  ui.invite.href = inviteUrl();
  ui.lobbyPlayers.innerHTML = '';
  for (const p of msg.players) {
    const li = document.createElement('li');
    li.className = p.ready ? 'ready' : '';
    const nm = document.createElement('span');
    nm.textContent = (p.id === msg.hostId ? '👑 ' : '') + p.name + (p.id === S.meId ? ' (du)' : '');
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = p.ready ? 'bereit' : 'wartet';
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = p.score ? String(p.score) : '';
    li.append(nm, pts, st);
    ui.lobbyPlayers.appendChild(li);
  }
  const n = msg.players.length;
  ui.lobbyHint.textContent = n < msg.min
    ? `Mindestens ${msg.min} Spieler nötig – lade jemanden ein (${n}/${msg.max}).`
    : `Startet, wenn alle bereit sind – oder der Host startet. ${n}/${msg.max} Spieler.`;
  ui.btnStart.hidden = !(msg.hostId === S.meId && msg.canStart);
  const inLobbyPhase = msg.phase === C.PHASE_LOBBY;
  ui.lobby.hidden = !inLobbyPhase;
  if (!inLobbyPhase) { S.ready = false; ui.btnReady.textContent = 'Bereit'; ui.btnReady.classList.remove('on'); }
}

// ---------------------------------------------------------------- Netz
function connect(join) {
  net = new Net();
  net.on('welcome', (w) => {
    S.meId = w.id; S.name = w.name; S.room = w.room; S.hostId = w.hostId;
    hud.meId = w.id;
    S.map = deserializeMap(w.map);
    renderer.setMap(w.map);
    ui.menu.hidden = true;
    hud.show(true);
    S.inGame = true;
    history.replaceState(null, '', `${location.pathname}?raum=${w.room}`);
    hud.chat('', `Willkommen im Raum ${w.room}. Enter öffnet den Chat, Tab zeigt die Tafel.`, true);
  });
  net.on('error', (e) => { showError(e.msg || 'Fehler'); setButtons(true); net.close(); });
  net.on('lobby', renderLobby);
  net.on('chat', (m) => hud.chat(m.from, m.text));
  net.on('kick', (m) => { ui.discReason.textContent = m.reason; });
  net.on('state', onState);
  net.on('close', (ev) => {
    if (!S.inGame) { if (!ui.menuError.textContent) showError('Keine Verbindung zum Server.'); setButtons(true); return; }
    S.inGame = false;
    ui.discReason.textContent ||= ev.reason || 'Der Server ist nicht mehr erreichbar.';
    ui.disconnected.hidden = false;
  });
  net.connect(join);
}

function onState(st) {
  const now = performance.now();
  S.state = st; S.stateAt = now; S.you = st.you;
  const you = st.you;

  // Vorhersage mit Serverposition abgleichen
  if (!S.pred) S.pred = { x: you.x, y: you.y, vx: you.vx, vy: you.vy, role: you.role };
  S.pred.role = you.role;
  const ex = you.x - S.pred.x, ey = you.y - S.pred.y;
  const err = Math.hypot(ex, ey);
  if (!canPredict() || err > 64) { S.pred.x = you.x; S.pred.y = you.y; S.pred.vx = you.vx; S.pred.vy = you.vy; }
  else { S.pred.x += ex * 0.3; S.pred.y += ey * 0.3; }

  renderer.pushSnapshot(st, now);

  // Phasenwechsel
  if (st.phase !== S.lastPhaseSeen) {
    S.lastPhaseSeen = st.phase;
    S.phase = st.phase;
    if (st.phase === C.PHASE_PREP) {
      renderer.clearAll();
      hud.el.roundend.hidden = true;
      hud.showCenter(`<span class="big">Runde ${st.round}</span>${you.role === C.ROLE_SEEKER ? 'Du bist Jäger – gleich geht es los.' : 'Du bist Chamäleon – versteck dich!'}`, 3500);
      audio.roundStart();
    } else if (st.phase === C.PHASE_HUNT) {
      hud.showCenter(`<span class="big">Die Jagd beginnt!</span>${you.role === C.ROLE_SEEKER ? 'Finde sie alle.' : 'Halte still. Halte durch.'}`, 3000);
      audio.huntStart();
    } else if (st.phase === C.PHASE_LOBBY) {
      renderer.clearAll();
      hud.el.roundend.hidden = true;
    }
  }
  // Countdown-Ticks
  const tl = Math.ceil(st.timeLeft);
  if ((st.phase === C.PHASE_PREP && tl <= 3 && tl >= 1) || (st.phase === C.PHASE_HUNT && tl <= 5 && tl >= 1)) {
    if (S.lastTickSound !== tl) { S.lastTickSound = tl; audio.tick(); }
  }

  for (const ev of st.events) handleEvent(ev, st);
}

function handleEvent(ev, st) {
  const me = S.meId;
  const near = (x, y) => S.pred && Math.hypot(x - S.pred.x, y - S.pred.y) < 700;
  switch (ev.k) {
    case 'catch':
      renderer.burst(ev.x, ev.y, 0xff8c42, 22, 4);
      if (ev.who === me) { audio.caught(); hud.showCenter('<span class="big">Erwischt!</span>', 2500); }
      else if (near(ev.x, ev.y)) audio.catchHit();
      hud.feed(`${ev.byName} hat ${ev.whoName} erwischt · ${ev.left} übrig`, 'catch');
      break;
    case 'lash':
      renderer.lash(ev.x, ev.y, ev.aim, ev.hit);
      if (!ev.hit && (ev.id === me || near(ev.x, ev.y))) audio.lashMiss();
      break;
    case 'scan':
      if (ev.id === me || near(ev.x, ev.y)) audio.scan();
      break;
    case 'scanhit':
      if (ev.id === me) { hud.feed('Der Scan hat dich erfasst! Beweg dich oder bleib ganz still.', 'catch'); audio.scanHit(); }
      else if (S.you?.role === C.ROLE_SEEKER) audio.scanHit();
      break;
    case 'grapple':
      if (ev.id === me || near(ev.x, ev.y)) audio.grapple();
      break;
    case 'grapplemiss':
      if (ev.id === me) { audio.grappleMiss(); hud.feed('Kein Anker in Zielrichtung (Säulen mit gelbem Ring).'); }
      break;
    case 'absorb':
      if (ev.id === me) { audio.absorb(); hud.feed('Farbe aufgenommen – kurz sichtbar!', 'good'); }
      renderer.burst(ev.x, ev.y, S.you?.color ?? [255, 255, 255], 8, 1.5);
      break;
    case 'decoy':
      if (ev.id === me) { audio.decoy(); hud.feed('Köder abgesetzt.', 'good'); }
      break;
    case 'decoypop':
      renderer.burst(ev.x, ev.y, 0xf0b429, 20, 4);
      if (near(ev.x, ev.y)) audio.decoyPop();
      if (ev.owner === me) hud.feed('Dein Köder hat einen Jäger betäubt! +' + C.PTS_DECOY_HIT, 'good');
      if (ev.by === me) hud.feed('Das war ein Köder – du bist kurz betäubt.', 'catch');
      break;
    case 'decoyfade':
      renderer.burst(ev.x, ev.y, 0xf0b429, 6, 1.5);
      break;
    case 'dash':
      if (ev.id === me || near(ev.x, ev.y)) audio.dash();
      break;
    case 'roundend': {
      const won = hud.roundEnd(ev, S.you?.role);
      won ? audio.win() : audio.lose();
      break;
    }
    case 'respawn':
      if (ev.id === me) hud.feed('Du bist jetzt Jäger. Finde die anderen!', 'catch');
      break;
    case 'converted':
      hud.feed(`${ev.name} ist jetzt Jäger (Ersatz).`, 'catch');
      break;
    case 'join': hud.chat('', `${ev.name} ist beigetreten.`, true); break;
    case 'leave': hud.chat('', `${ev.name} hat den Raum verlassen.`, true); break;
    default: break;
  }
}

/** Darf der Client seine Bewegung selbst vorausberechnen? */
function canPredict() {
  const y = S.you;
  if (!y || !y.alive || y.grapple || y.stun > 0 || y.dash) return false;
  if (S.phase === C.PHASE_OVER) return false;
  if (y.role === C.ROLE_SEEKER && S.phase === C.PHASE_PREP) return false;
  return true;
}

// ---------------------------------------------------------------- Tasten fuer UI
input.onKey = (e, down) => {
  if (!S.inGame) return true;
  if (e.code === 'Tab') { e.preventDefault(); hud.scoreboard(down); return false; }
  if (down && e.code === 'Enter') {
    if (document.activeElement === ui.chatInput) {
      const text = ui.chatInput.value.trim();
      if (text) net?.send({ t: 'chat', text });
      ui.chatInput.value = '';
      ui.chatInput.blur();
    } else if (!ui.lobby.hidden) {
      return true;
    } else {
      ui.chatInput.focus();
    }
    e.preventDefault();
    return false;
  }
  if (down && e.code === 'Escape') { ui.chatInput.blur(); return false; }
  return true;
};

// ---------------------------------------------------------------- Zielrichtung
/** Zielwinkel und Kamera-Vorlauf aus der Mausposition. */
function computeAim() {
  let aim = S.pred?.aim ?? 0;
  let lean = { x: 0, y: 0 };
  if (!S.pred) return { aim, lean };
  const w = renderer.screenToWorld(input.mouse.x, input.mouse.y);
  if (w) {
    const dx = w.x - S.pred.x, dy = w.y - S.pred.y;
    if (Math.hypot(dx, dy) > 4) aim = Math.atan2(dy, dx);
    const d = Math.min(1, Math.hypot(dx, dy) / 600);
    lean = { x: dx * 0.22 * d, y: dy * 0.22 * d };
  }
  S.pred.aim = aim;
  return { aim, lean };
}

// ---------------------------------------------------------------- Eingabeversand
// Eigener Takt, unabhaengig vom Rendern: auch bei niedriger Bildrate kommen
// Eingaben puenktlich beim Server an.
function sendInput() {
  if (!S.inGame || !S.pred || !net) return;
  const { aim } = computeAim();
  const a = input.takeActions();
  const anyAction = Object.values(a).some(Boolean);
  const chatOpen = document.activeElement === ui.chatInput;
  net.send({
    t: 'input', seq: ++S.seq, aim,
    k: chatOpen ? { up: false, down: false, left: false, right: false, sprint: false, absorb: false } : input.keys,
    a: anyAction && !chatOpen ? a : undefined,
  });
}
setInterval(sendInput, 1000 / C.INPUT_RATE);

// ---------------------------------------------------------------- Schleife
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (S.inGame && S.pred && S.you && S.map) {
    const { aim, lean } = computeAim();

    // Vorhersage der eigenen Bewegung
    const y = S.you;
    if (canPredict()) {
      const sprintAllowed = y.role === C.ROLE_HIDER && input.keys.sprint && y.stamina > 0;
      stepMovement(S.pred, input.keys, dt, S.map, { sprintAllowed });
    } else {
      // Server fuehrt: weich hinterher
      S.pred.x += (y.x - S.pred.x) * Math.min(1, dt * 12);
      S.pred.y += (y.y - S.pred.y) * Math.min(1, dt * 12);
      S.pred.vx = 0; S.pred.vy = 0;
    }

    renderer.update({
      dt, now, phase: S.phase, meId: S.meId,
      me: {
        x: S.pred.x, y: S.pred.y, aim, role: y.role, alive: y.alive, color: y.color, vis: y.vis,
        grapple: y.grapple, absorb: y.absorb, stun: y.stun, mark: y.mark, sprint: y.sprint, dash: y.dash,
        speed: Math.hypot(S.pred.vx, S.pred.vy), lean,
      },
    });
    hud.update(S.state, y, net?.rtt ?? 0);
  } else {
    renderer.update({ dt, now, me: null, phase: S.phase, meId: null });
  }
}
requestAnimationFrame(frame);

// Bei Fokusverlust Eingaben loeschen, damit niemand "weiterlaeuft".
window.addEventListener('blur', () => input.reset());
document.addEventListener('visibilitychange', () => { if (document.hidden) input.reset(); });

// Fuer automatisierte Browsertests und Fehlersuche in der Konsole.
window.__cc = { S, renderer, hud, input, get net() { return net; } };
