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
// Text sicher in HTML einsetzen (Spielernamen landen in innerHTML-Meldungen).
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
// Ab hier laeuft das Spiel: Einzelfehler gehen in die Konsole statt in den Vollbild-Fehlerkasten.
window.__booted = true;
const input = new Input(renderer.renderer.domElement);
const audio = new Audio();
const hud = new Hud();
let net = null;
let painter = null;
let pendingAim = null;     // Zielrichtung zum Zeitpunkt des Klicks

// Treffermarker: kurzes X um das Fadenkreuz, rot bei Fang.
const hitmarker = document.createElement('div');
hitmarker.id = 'hitmarker';
hitmarker.setAttribute('aria-hidden', 'true');
hitmarker.style.cssText = 'position:fixed;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;pointer-events:none;z-index:13;opacity:0;transition:opacity .25s ease-out;';
hitmarker.innerHTML = '<svg viewBox="0 0 34 34" width="34" height="34"><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 4l8 8M30 4l-8 8M4 30l8-8M30 30l-8-8"/></g></svg>';
document.body.appendChild(hitmarker);
let hitmarkerTimer = 0;
function showHitmarker(color) {
  hitmarker.style.color = color;
  hitmarker.style.transition = 'none';
  hitmarker.style.opacity = '1';
  clearTimeout(hitmarkerTimer);
  hitmarkerTimer = setTimeout(() => { hitmarker.style.transition = 'opacity .25s ease-out'; hitmarker.style.opacity = '0'; }, 120);
}

const S = {
  meId: null, name: '', room: null, hostId: null, map: null,
  state: null, stateAt: 0, you: null,
  pred: null, seq: 0, predHist: [],
  ready: false,
  phase: C.PHASE_LOBBY,
  inGame: false,
  lastPhaseSeen: null,
  lastTickSound: -1,
};

// ---------------------------------------------------------------- Menue
// localStorage kann gesperrt sein (privates Fenster) - dann ohne gespeicherte Werte weiter.
ui.name.value = loadSetting('cc-name', '');
ui.lowfx.checked = loadSetting('cc-lowfx', '0') === '1';
ui.lowfx.onchange = () => { saveSetting('cc-lowfx', ui.lowfx.checked ? '1' : '0'); renderer.setLowFx(ui.lowfx.checked); };
const urlRoom = new URLSearchParams(location.search).get('raum');
if (urlRoom) ui.code.value = urlRoom.toUpperCase().slice(0, C.ROOM_CODE_LEN);

function showError(msg) { ui.menuError.textContent = msg; ui.menuError.hidden = !msg; }

function start(mode) {
  const name = ui.name.value.trim().slice(0, C.NAME_MAX);
  saveSetting('cc-name', name);
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
  input.onPrimary = () => {
    if (!S.pred || S.you?.role !== C.ROLE_SEEKER) return;
    pendingAim = renderer.aimFrom(S.pred.x, S.pred.y);
  };
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
  // Abgleich mit dem Server: Verglichen wird mit der Position, die wir vorhergesagt hatten,
  // als wir die letzte vom Server verarbeitete Eingabe (st.seq) schickten - nicht mit der
  // aktuellen. Sonst zieht die alte Serverposition die Figur beim Laufen staendig zurueck.
  const hist = S.predHist;
  let ref = null;
  while (hist.length && hist[0].seq < st.seq) hist.shift();
  if (hist.length && hist[0].seq === st.seq) ref = hist.shift();
  const ex = you.x - (ref ? ref.x : S.pred.x), ey = you.y - (ref ? ref.y : S.pred.y);
  const err = Math.hypot(ex, ey);
  if (!canPredict() || err > 64) {
    S.pred.x = you.x; S.pred.y = you.y; S.pred.vx = you.vx; S.pred.vy = you.vy;
    hist.length = 0;
  } else if (err > 0.5) {
    // Sanft korrigieren und die noch offenen Eintraege mitverschieben.
    const k = ref ? 0.35 : 0.3;
    S.pred.x += ex * k; S.pred.y += ey * k;
    for (const h of hist) { h.x += ex * k; h.y += ey * k; }
  }

  renderer.pushSnapshot(st, now);

  if (st.phase !== S.lastPhaseSeen) {
    S.lastPhaseSeen = st.phase;
    S.phase = st.phase;
    // Lobby-Tafel sofort weg, nicht erst mit der naechsten Lobby-Nachricht (bis zu 1 s spaeter).
    if (st.phase !== C.PHASE_LOBBY) { ui.lobby.hidden = true; input.wantLock = true; }
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
  switch (ev.k) {
    case 'shot':
      renderer.shot(ev);
      if (ev.id === me && ev.hit) showHitmarker('#ffffff');
      {
        // Eigener Schuss direkt, fremde raeumlich (Sucher hoeren sich gegenseitig, Chamaeleons hoeren die Gefahr).
        const pos = ev.id === me ? null : { x: ev.x, y: ev.y };
        audio.shot(pos);
        const endPos = { x: ev.to.x * C.TILE, y: ev.to.y * C.TILE };
        if (ev.hit) audio.catchHit(ev.id === me ? null : endPos); else if (ev.id === me) audio.lashMiss(endPos);
      }
      break;
    case 'catch':
      if (ev.who === me) { audio.caught(); hud.showCenter('<span class="big">Gefunden!</span>', 2500); }
      if (ev.by === me) { showHitmarker('#ff3d6e'); hud.showCenter(`<span class="big">Gefunden!</span>${esc(ev.whoName)} +${C.PTS_CATCH}`, 1600); }
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
      audio.decoyPop({ x: ev.x, y: ev.y });
      if (ev.owner === me) hud.feed('Dein Köder hat einen Sucher reingelegt! +' + C.PTS_DECOY_HIT, 'good');
      if (ev.by === me) hud.feed('Das war ein Köder – du bist kurz benommen.', 'catch');
      break;
    case 'decoyfade':
      renderer.burst(ev.x, ev.y, 0xf0b429, 6, 1.5);
      break;
    case 'dash':
      audio.dash(ev.id === me ? null : { x: ev.x, y: ev.y });
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

/** Schritte der anderen Figuren: leise und raeumlich - wer rennt, ist zu hoeren. */
function footsteps(dt) {
  for (const e of renderer.entities.values()) {
    if (e.gone || !e.cur || !e.group.visible) continue;
    const sp = e.speedEst ?? 0;
    if (sp < 40) { e.stepT = 0; continue; }
    e.stepT = (e.stepT ?? 0) + dt * (sp / 150);
    if (e.stepT >= 0.42) { e.stepT = 0; audio.step({ x: e.cur.x, y: e.cur.y }, sp > 160); }
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
      // Im Malmodus ist der Chat ausgeblendet - erst den Malmodus schliessen, sonst landen
      // getippte Buchstaben als Spieltasten (F, R, Q) im Spiel.
      if (painter?.active) painter.setActive(false);
      input.reset();
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
  let aim;
  if (a.primary && !painting && !chatOpen) {
    // Zielrichtung vom Klick; lag = wie weit der Server die Ziele zurueckspulen soll
    // (Interpolationspuffer + Netzlaufzeit).
    const dir = pendingAim ?? renderer.aimFrom(S.pred.x, S.pred.y);
    aim = { yaw: dir.yaw, pitch: dir.pitch, lag: C.INTERP_DELAY_MS + (net.rtt || 0) };
  }
  pendingAim = null;
  S.predHist.push({ seq: S.seq + 1, x: S.pred.x, y: S.pred.y });
  if (S.predHist.length > 90) S.predHist.shift();
  net.send({
    t: 'input', seq: ++S.seq,
    look: { yaw: input.look.yaw, pitch: input.look.pitch },
    k: chatOpen || painting ? none : input.keys,
    a: anyAction && !chatOpen ? a : undefined,
    aim,
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
      // Gleiche Regel wie der Server: Losspurten erst ab Mindestausdauer, dann bis leer.
      const sprintAllowed = y.role === C.ROLE_HIDER && input.keys.sprint && (y.sprint ? y.stamina > 0 : y.stamina >= C.STAMINA_SPRINT_MIN);
      stepMovement(S.pred, input.keys, dt, S.map, { sprintAllowed, yaw: input.look.yaw });
    } else {
      S.pred.x += (y.x - S.pred.x) * Math.min(1, dt * 12);
      S.pred.y += (y.y - S.pred.y) * Math.min(1, dt * 12);
      S.pred.vx = 0; S.pred.vy = 0;
    }
    painter?.update(now);
    const speed = Math.hypot(S.pred.vx, S.pred.vy);
    audio.setListener(S.pred.x, S.pred.y, input.look.yaw);
    footsteps(dt);
    // Die Figur schaut in Blickrichtung; in Posen behaelt sie ihre Ausrichtung.
    renderer.update({
      dt, now, meId: S.meId, paintMode: !!painter?.active,
      me: {
        x: S.pred.x, y: S.pred.y, yaw: input.look.yaw, pitch: input.look.pitch, role: y.role, alive: y.alive,
        bodyYaw: y.pose ? (y.poseYaw ?? input.look.yaw) : input.look.yaw,
        pose: y.pose, stun: y.stun, speed, painting: y.painting,
      },
    });
    hud.update(S.state, y, net?.rtt ?? 0, { painting: !!painter?.active, locked: input.locked });
  } else {
    renderer.update({ dt, now, me: null, meId: null });
  }
}
requestAnimationFrame(frame);

// Alt+Tab: Tasten und Punktetafel loslassen (das keyup kommt nie an).
window.addEventListener('blur', () => { input.reset(); hud.scoreboard(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { input.reset(); hud.scoreboard(false); } });

// ---------------------------------------------------------------- Einstellungen (Maus)
const BASE_SENS = 0.0022;
function loadSetting(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function saveSetting(key, v) { try { localStorage.setItem(key, v); } catch { /* egal */ } }
const sensEl = $('sens'), invEl = $('invert-y'), sensVal = $('sens-val');
const sens = Math.min(3, Math.max(0.2, Number(loadSetting('cc-sens', '1')) || 1));
input.sensitivity = BASE_SENS * sens;
input.invertY = loadSetting('cc-invert', '0') === '1';
if (sensEl) {
  sensEl.value = String(sens);
  if (sensVal) sensVal.textContent = sens.toFixed(2) + '×';
  sensEl.oninput = () => {
    const v = Number(sensEl.value) || 1;
    input.sensitivity = BASE_SENS * v;
    if (sensVal) sensVal.textContent = v.toFixed(2) + '×';
    saveSetting('cc-sens', String(v));
  };
}
if (invEl) {
  invEl.checked = input.invertY;
  invEl.onchange = () => { input.invertY = invEl.checked; saveSetting('cc-invert', invEl.checked ? '1' : '0'); };
}

// Fuer automatisierte Browsertests und Fehlersuche in der Konsole.
window.__cc = { S, renderer, hud, input, get net() { return net; }, get painter() { return painter; } };
