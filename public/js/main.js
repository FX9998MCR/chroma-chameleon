// Einstiegspunkt: Menue, Lobby, Spielschleife, Vorhersage, Malmodus, Ereignisse.

import * as C from '/shared/constants.js';
import { stepMovement } from '/shared/physics.js';
import { deserializeMap } from '/shared/map.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Painter } from './paint.js';

const $ = (id) => document.getElementById(id);

const ui = {
  menu: $('menu'), lobby: $('lobby'), name: $('name'), code: $('code'), menuError: $('menu-error'),
  btnQuick: $('btn-quick'), btnCreate: $('btn-create'), btnJoin: $('btn-join'), btnSolo: $('btn-solo'),
  botrow: $('botrow'), btnAddBot: $('btn-addbot'), btnRemoveBot: $('btn-removebot'),
  lobbyCode: $('lobby-code'), invite: $('invite'), btnCopy: $('btn-copy'), lobbyPlayers: $('lobby-players'),
  lobbyHint: $('lobby-hint'), btnReady: $('btn-ready'), btnStart: $('btn-start'), btnLeave: $('btn-leave'),
  disconnected: $('disconnected'), discReason: $('disc-reason'), btnReload: $('btn-reload'), chatInput: $('chat-input'),
  lowfx: $('lowfx'),
};

let renderer;
try {
  renderer = new Renderer($('game'), $('labels'));
} catch (err) {
  // WebGL-Kontext liess sich nicht anlegen (Treiber, abgeschaltete Hardwarebeschleunigung, ...).
  window.__fatal?.('3D-Darstellung konnte nicht gestartet werden: ' + (err?.message ?? err)
    + '\nBitte im Browser die Hardwarebeschleunigung aktivieren oder den Leistungsmodus (?lowfx=1 an die Adresse anhängen) probieren.');
  throw err;
}
const input = new Input(renderer.renderer.domElement);
const audio = new Audio();
const hud = new Hud();
let net = null;
let painter = null;

const S = {
  meId: null, name: '', room: null, hostId: null, map: null,
  state: null, stateAt: 0, you: null,
  pred: null, seq: 0,
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
  connect({ mode, name, room, public: false, bots: 3 });
}

function setButtons(on) { for (const b of [ui.btnQuick, ui.btnCreate, ui.btnJoin, ui.btnSolo]) b.disabled = !on; }

ui.btnQuick.onclick = () => start('quick');
ui.btnSolo.onclick = () => start('solo');
ui.btnAddBot.onclick = () => net?.send({ t: 'addbot' });
ui.btnRemoveBot.onclick = () => net?.send({ t: 'removebot' });
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
    li.className = (p.ready ? 'ready' : '') + (p.bot ? ' bot' : '');
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
    ? `Mindestens ${msg.min} Spieler nötig – lade jemanden ein oder füge Bots hinzu (${n}/${msg.max}).`
    : `Startet, wenn alle bereit sind – oder der Host startet. ${n}/${msg.max} Spieler.`;
  ui.btnStart.hidden = !(msg.hostId === S.meId && msg.canStart);
  ui.botrow.hidden = msg.hostId !== S.meId;
  ui.btnAddBot.disabled = n >= msg.max;
  ui.btnRemoveBot.disabled = !msg.players.some((p) => p.bot);
  const inLobbyPhase = msg.phase === C.PHASE_LOBBY;
  ui.lobby.hidden = !inLobbyPhase;
  input.wantLock = !inLobbyPhase;
  if (inLobbyPhase) input.releaseLock();
  if (!inLobbyPhase) { S.ready = false; ui.btnReady.textContent = 'Bereit'; ui.btnReady.classList.remove('on'); }
}

// ---------------------------------------------------------------- Netz
function connect(join) {
  net = new Net();
  painter = new Painter(renderer, input, net);
  input.onTogglePaint = () => {
    if (!S.you || S.you.role !== C.ROLE_HIDER || !S.you.alive || S.phase === C.PHASE_OVER || S.phase === C.PHASE_LOBBY) return;
    painter.toggle();
    if (painter.active) hud.showCenter('<span class="big">Malmodus</span>Leertaste: Farbe aufnehmen · Linke Maustaste: malen · Rechte Maustaste: drehen · F: fertig', 4000);
  };
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
  net.on('paint', (m) => renderer.applyPaint(m.id, m.paint, S.meId));
  net.on('paintall', (m) => { for (const it of m.items) renderer.applyPaint(it.id, it.paint, S.meId); });
  net.on('state', onState);
  net.on('close', (ev) => {
    if (!S.inGame) { if (!ui.menuError.textContent) showError('Keine Verbindung zum Server.'); setButtons(true); return; }
    S.inGame = false;
    input.releaseLock();
    ui.discReason.textContent ||= ev.reason || 'Der Server ist nicht mehr erreichbar.';
    ui.disconnected.hidden = false;
  });
  net.connect(join);
}

function onState(st) {
  const now = performance.now();
  S.state = st; S.stateAt = now; S.you = st.you;
  const you = st.you;

  if (!S.pred) S.pred = { x: you.x, y: you.y, vx: you.vx, vy: you.vy, role: you.role };
  S.pred.role = you.role;
  const ex = you.x - S.pred.x, ey = you.y - S.pred.y;
  const err = Math.hypot(ex, ey);
  if (!canPredict() || err > 64) { S.pred.x = you.x; S.pred.y = you.y; S.pred.vx = you.vx; S.pred.vy = you.vy; }
  else { S.pred.x += ex * 0.3; S.pred.y += ey * 0.3; }

  renderer.pushSnapshot(st, now);

  if (st.phase !== S.lastPhaseSeen) {
    S.lastPhaseSeen = st.phase;
    S.phase = st.phase;
    if (st.phase === C.PHASE_PREP) {
      renderer.clearAll();
      painter?.reset();
      hud.el.roundend.hidden = true;
      hud.showCenter(`<span class="big">Runde ${st.round}</span>${you.role === C.ROLE_SEEKER ? 'Du bist Sucher – gleich geht es los.' : 'Du bist Chamäleon – such ein Versteck und mal dich an (F)!'}`, 4000);
      audio.roundStart();
    } else if (st.phase === C.PHASE_HUNT) {
      hud.showCenter(`<span class="big">Die Suche beginnt!</span>${you.role === C.ROLE_SEEKER ? 'Schau genau hin. Linke Maustaste markiert.' : 'Nicht bewegen. Nicht auffallen.'}`, 3000);
      audio.huntStart();
    } else if (st.phase === C.PHASE_LOBBY) {
      renderer.clearAll();
      painter?.reset();
      hud.el.roundend.hidden = true;
    } else if (st.phase === C.PHASE_OVER) {
      if (painter?.active) painter.setActive(false);
    }
  }
  if (painter?.active && (!you.alive || you.role !== C.ROLE_HIDER)) painter.setActive(false);

  const tl = Math.ceil(st.timeLeft);
  if ((st.phase === C.PHASE_PREP && tl <= 3 && tl >= 1) || (st.phase === C.PHASE_HUNT && tl <= 5 && tl >= 1)) {
    if (S.lastTickSound !== tl) { S.lastTickSound = tl; audio.tick(); }
  }

  for (const ev of st.events) handleEvent(ev, st);
}

function handleEvent(ev) {
  const me = S.meId;
  const near = (x, y) => S.pred && Math.hypot(x - S.pred.x, y - S.pred.y) < 700;
  switch (ev.k) {
    case 'shot':
      renderer.shot(ev);
      if (ev.id === me || near(ev.x, ev.y)) { ev.hit ? audio.catchHit() : audio.lashMiss(); }
      break;
    case 'catch':
      if (ev.who === me) { audio.caught(); hud.showCenter('<span class="big">Gefunden!</span>', 2500); }
      hud.feed(`${ev.byName} hat ${ev.whoName} gefunden · ${ev.left} übrig`, 'catch');
      break;
    case 'paint':
      renderer.applyPaint(ev.id, ev.paint, me);
      break;
    case 'pose':
      if (ev.id === me) { hud.showCenter(`<span class="big">${C.POSES[ev.pose]?.name ?? ''}</span>`, 1200); }
      break;
    case 'decoy':
      if (ev.id === me) { audio.decoy(); hud.feed('Köder abgesetzt – eine Kopie von dir.', 'good'); }
      break;
    case 'decoypop':
      renderer.burst(ev.x, ev.y, 0xf0b429, 20, 4);
      if (near(ev.x, ev.y)) audio.decoyPop();
      if (ev.owner === me) hud.feed('Dein Köder hat einen Sucher reingelegt! +' + C.PTS_DECOY_HIT, 'good');
      if (ev.by === me) hud.feed('Das war ein Köder – du bist kurz benommen.', 'catch');
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
      if (ev.id === me) hud.feed('Du bist jetzt Sucher. Finde die anderen!', 'catch');
      break;
    case 'converted':
      hud.feed(`${ev.name} ist jetzt Sucher (Ersatz).`, 'catch');
      break;
    case 'join': hud.chat('', `${ev.name} ist beigetreten.`, true); break;
    case 'leave': hud.chat('', `${ev.name} hat den Raum verlassen.`, true); break;
    default: break;
  }
}

function canPredict() {
  const y = S.you;
  if (!y || !y.alive || y.stun > 0 || y.dash || y.painting || painter?.active) return false;
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
      if (input.wantLock && !painter?.active) input.requestLock();
    } else if (!ui.lobby.hidden) {
      return true;
    } else {
      input.releaseLock();
      ui.chatInput.focus();
    }
    e.preventDefault();
    return false;
  }
  if (down && e.code === 'Escape') { ui.chatInput.blur(); if (painter?.active) painter.setActive(false); return false; }
  return true;
};

// ---------------------------------------------------------------- Eingabeversand (30 Hz)
function sendInput() {
  if (!S.inGame || !S.pred || !net) return;
  const a = input.takeActions();
  const chatOpen = document.activeElement === ui.chatInput;
  const painting = !!painter?.active;
  const anyAction = !painting && Object.values(a).some(Boolean);
  const none = { up: false, down: false, left: false, right: false, sprint: false, paint: painting };
  net.send({
    t: 'input', seq: ++S.seq,
    look: { yaw: input.look.yaw, pitch: input.look.pitch },
    k: chatOpen || painting ? none : input.keys,
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
    const y = S.you;
    if (canPredict()) {
      const sprintAllowed = y.role === C.ROLE_HIDER && input.keys.sprint && y.stamina > 0;
      stepMovement(S.pred, input.keys, dt, S.map, { sprintAllowed, yaw: input.look.yaw });
    } else {
      S.pred.x += (y.x - S.pred.x) * Math.min(1, dt * 12);
      S.pred.y += (y.y - S.pred.y) * Math.min(1, dt * 12);
      S.pred.vx = 0; S.pred.vy = 0;
    }
    painter?.update(now);
    const speed = Math.hypot(S.pred.vx, S.pred.vy);
    // Die Figur schaut in Blickrichtung; in Posen behaelt sie ihre Ausrichtung.
    renderer.update({
      dt, now, meId: S.meId, paintMode: !!painter?.active,
      me: {
        x: S.pred.x, y: S.pred.y, yaw: input.look.yaw, pitch: input.look.pitch, role: y.role, alive: y.alive,
        pose: y.pose, stun: y.stun, speed, painting: y.painting,
      },
    });
    hud.update(S.state, y, net?.rtt ?? 0, { painting: !!painter?.active, locked: input.locked });
  } else {
    renderer.update({ dt, now, me: null, meId: null });
  }
}
requestAnimationFrame(frame);

window.addEventListener('blur', () => input.reset());
document.addEventListener('visibilitychange', () => { if (document.hidden) input.reset(); });

// Fuer automatisierte Browsertests und Fehlersuche in der Konsole.
window.__cc = { S, renderer, hud, input, get net() { return net; }, get painter() { return painter; } };
