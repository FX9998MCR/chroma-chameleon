// Autoritative Spielsimulation eines Raums.
// Der Server rechnet alles selbst; Clients schicken nur Eingaben.
// Sichtbarkeit wird HIER entschieden: Was ein Jaeger nicht sehen darf,
// verlaesst den Server nicht (Schutz gegen Wallhacks).

import * as C from '../shared/constants.js';
import { tileAt, tileColorAt, isSolidAt } from '../shared/map.js';
import {
  clamp, angleDiff, stepMovement, baseVisibility, visibilityForSeeker,
  raycastSolid, slideMove,
} from '../shared/physics.js';

const EMPTY_INPUT = Object.freeze({
  up: false, down: false, left: false, right: false, sprint: false, absorb: false,
});

let nextEntityId = 1;

/** Zustand eines Spielers auf dem Server. */
export function makePlayer(id, name) {
  return {
    id, name,
    role: C.ROLE_HIDER,
    alive: true,
    x: 0, y: 0, vx: 0, vy: 0, aim: 0,
    color: C.PALETTE[7].slice(),   // Start: neutrales Basalt, faellt ueberall auf
    stillTime: 0,
    shimmer: 0,
    lastMoveT: 99,                 // Sekunden seit letzter deutlicher Bewegung
    stamina: C.STAMINA_MAX,
    staminaDelay: 0,
    sprinting: false,
    absorbing: 0,
    grapple: null,                 // {ax, ay, t}
    grappleCd: 0, decoyCd: 0, scanCd: 0, dashCd: 0, catchCd: 0,
    dashT: 0, dashDir: 0,
    stunT: 0,
    markT: 0,
    respawnT: 0,
    splatT: 0,
    score: 0,                      // Gesamtpunkte ueber alle Runden
    roundScore: 0,
    survivePts: 0,                 // Bruchteile fuer Sekundenpunkte
    catches: 0,
    seekerRounds: 0,               // Fairness bei der Rollenverteilung
    ready: false,
    input: { ...EMPTY_INPUT },
    actions: { primary: false, decoy: false, grapple: false, scan: false, dash: false },
    seq: 0,
  };
}

export class Game {
  /**
   * @param {object} map   generierte Karte
   * @param {object} opts  {rng: () => number}
   */
  constructor(map, opts = {}) {
    this.map = map;
    this.rng = opts.rng ?? Math.random;
    this.players = new Map();
    this.phase = C.PHASE_LOBBY;
    this.phaseTime = 0;         // verbleibende Sekunden der Phase
    this.round = 0;
    this.tick = 0;
    this.time = 0;
    this.decoys = [];           // {id, x, y, color, owner, t}
    this.splats = [];           // {x, y, color, t}
    this.scans = [];            // {id, x, y, r, t, hit:Set}
    this.events = [];           // seit letztem Snapshot
    this.lastWinner = null;
    this.hidersTotal = 0;
    this.seekerSpawn = this.pickSeekerSpawn();
  }

  // ---------------------------------------------------------------- Spieler
  addPlayer(id, name) {
    const p = makePlayer(id, name);
    const s = this.randomSpawn();
    p.x = s.x; p.y = s.y;
    this.players.set(id, p);
    this.pushEvent({ k: 'join', name });
    // Wer mitten in einer Runde kommt, jagt mit - so wartet niemand.
    if (this.phase === C.PHASE_PREP || this.phase === C.PHASE_HUNT) {
      this.becomeSeeker(p, true);
    }
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.decoys = this.decoys.filter((d) => d.owner !== id);
    this.pushEvent({ k: 'leave', name: p.name });
    if (this.phase === C.PHASE_PREP || this.phase === C.PHASE_HUNT) {
      this.ensureSeekerExists();
      this.checkRoundEnd();
    }
  }

  setInput(id, inp, actions, aim, seq) {
    const p = this.players.get(id);
    if (!p) return;
    p.input = {
      up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
      sprint: !!inp.sprint, absorb: !!inp.absorb,
    };
    if (Number.isFinite(aim)) p.aim = aim;
    if (Number.isFinite(seq)) p.seq = seq;
    // Aktionen sind flankengesteuert: einmal gesetzt, bis verbraucht.
    if (actions) {
      for (const k of Object.keys(p.actions)) if (actions[k]) p.actions[k] = true;
    }
  }

  setReady(id, ready) {
    const p = this.players.get(id);
    if (p) p.ready = !!ready;
  }

  get hiders() { return [...this.players.values()].filter((p) => p.role === C.ROLE_HIDER); }
  get seekers() { return [...this.players.values()].filter((p) => p.role === C.ROLE_SEEKER); }
  get aliveHiders() { return this.hiders.filter((p) => p.alive); }

  pushEvent(ev) { this.events.push({ ...ev, t: this.time }); }

  randomSpawn() {
    const s = this.map.spawns;
    if (!s.length) return { x: C.WORLD_W / 2, y: C.WORLD_H / 2 };
    return s[(this.rng() * s.length) | 0];
  }

  /** Jaeger starten gemeinsam an einem Punkt nahe der Kartenmitte. */
  pickSeekerSpawn() {
    const cx = C.WORLD_W / 2, cy = C.WORLD_H / 2;
    let best = null, bestD = Infinity;
    for (const s of this.map.spawns) {
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ?? { x: cx, y: cy };
  }

  /** Startplatz fuer Chamaeleons: moeglichst weit weg vom Jaeger-Start. */
  hiderSpawn(used) {
    const cands = this.map.spawns
      .filter((s) => !used.has(s))
      .map((s) => ({ s, d: Math.hypot(s.x - this.seekerSpawn.x, s.y - this.seekerSpawn.y) }))
      .filter((c) => c.d > 260)
      .sort((a, b) => b.d - a.d);
    const pool = cands.length ? cands.slice(0, Math.max(4, cands.length >> 1)) : null;
    if (!pool) return this.randomSpawn();
    const pick = pool[(this.rng() * pool.length) | 0].s;
    used.add(pick);
    return pick;
  }

  // ---------------------------------------------------------------- Runden
  canStart() {
    return this.players.size >= C.MIN_PLAYERS && this.phase === C.PHASE_LOBBY;
  }

  allReady() {
    if (this.players.size < C.MIN_PLAYERS) return false;
    for (const p of this.players.values()) if (!p.ready) return false;
    return true;
  }

  startRound() {
    if (this.players.size < C.MIN_PLAYERS) return false;
    this.round++;
    this.phase = C.PHASE_PREP;
    this.phaseTime = C.PREP_SECONDS;
    this.decoys = [];
    this.splats = [];
    this.scans = [];
    this.lastWinner = null;

    const all = [...this.players.values()];
    const seekerCount = Math.max(1, Math.ceil(all.length / C.SEEKER_RATIO));
    // Wer selten Jaeger war, kommt zuerst dran; Gleichstand entscheidet der Zufall.
    const order = all
      .map((p) => ({ p, r: this.rng() }))
      .sort((a, b) => a.p.seekerRounds - b.p.seekerRounds || a.r - b.r)
      .map((o) => o.p);
    const used = new Set();
    order.forEach((p, i) => {
      this.resetForRound(p);
      p.ready = false;
      if (i < seekerCount) {
        p.role = C.ROLE_SEEKER;
        p.seekerRounds++;
        p.x = this.seekerSpawn.x + (this.rng() - 0.5) * 40;
        p.y = this.seekerSpawn.y + (this.rng() - 0.5) * 40;
        // Falls der Zufall in eine Wand traf: zurueck auf den Punkt.
        if (isSolidAt(this.map, p.x, p.y)) { p.x = this.seekerSpawn.x; p.y = this.seekerSpawn.y; }
      } else {
        p.role = C.ROLE_HIDER;
        const s = this.hiderSpawn(used);
        p.x = s.x; p.y = s.y;
      }
    });
    this.hidersTotal = this.hiders.length;
    this.pushEvent({ k: 'phase', phase: this.phase, round: this.round });
    return true;
  }

  resetForRound(p) {
    p.alive = true;
    p.vx = 0; p.vy = 0;
    p.color = C.PALETTE[7].slice();
    p.stillTime = 0; p.shimmer = 0; p.lastMoveT = 99;
    p.stamina = C.STAMINA_MAX; p.staminaDelay = 0;
    p.absorbing = 0; p.grapple = null;
    p.grappleCd = 0; p.decoyCd = 0; p.scanCd = 0; p.dashCd = 0; p.catchCd = 0;
    p.dashT = 0; p.stunT = 0; p.markT = 0; p.respawnT = 0; p.splatT = 0;
    p.roundScore = 0; p.survivePts = 0; p.catches = 0;
    p.actions = { primary: false, decoy: false, grapple: false, scan: false, dash: false };
  }

  becomeSeeker(p, immediate = false) {
    p.role = C.ROLE_SEEKER;
    p.alive = true;
    p.grapple = null;
    p.absorbing = 0;
    p.markT = 0;
    p.scanCd = immediate ? 2 : 0;
    p.dashCd = 0;
    p.catchCd = 0.5;
    p.x = this.seekerSpawn.x;
    p.y = this.seekerSpawn.y;
    p.vx = 0; p.vy = 0;
  }

  /** Ohne Jaeger keine Jagd: notfalls wird ein Chamaeleon umgedreht. */
  ensureSeekerExists() {
    if (this.seekers.length > 0) return;
    const pool = this.aliveHiders;
    if (pool.length <= 1) return;   // dann endet die Runde ohnehin
    const p = pool[(this.rng() * pool.length) | 0];
    this.becomeSeeker(p, true);
    this.pushEvent({ k: 'converted', id: p.id, name: p.name });
  }

  endRound(winner) {
    this.phase = C.PHASE_OVER;
    this.phaseTime = C.OVER_SECONDS;
    this.lastWinner = winner;
    const alive = this.aliveHiders;
    for (const p of alive) {
      p.roundScore += C.PTS_SURVIVE_ROUND;
      if (alive.length === 1) p.roundScore += C.PTS_LAST_ONE;
    }
    for (const p of this.players.values()) {
      p.score += Math.round(p.roundScore);
      p.grapple = null; p.dashT = 0; p.stunT = 0;
    }
    this.pushEvent({
      k: 'roundend', winner, round: this.round,
      survivors: alive.map((p) => p.name),
      scores: [...this.players.values()]
        .sort((a, b) => b.roundScore - a.roundScore)
        .map((p) => ({ id: p.id, name: p.name, role: p.role, round: Math.round(p.roundScore), total: p.score })),
    });
  }

  checkRoundEnd() {
    if (this.phase !== C.PHASE_HUNT) return;
    if (this.players.size < C.MIN_PLAYERS) { this.toLobby(); return; }
    if (this.aliveHiders.length === 0) this.endRound(C.ROLE_SEEKER);
  }

  toLobby() {
    this.phase = C.PHASE_LOBBY;
    this.phaseTime = 0;
    this.decoys = []; this.splats = []; this.scans = [];
    for (const p of this.players.values()) {
      this.resetForRound(p);
      p.role = C.ROLE_HIDER;
      p.ready = false;
      const s = this.randomSpawn();
      p.x = s.x; p.y = s.y;
    }
    this.pushEvent({ k: 'phase', phase: this.phase });
  }

  // ---------------------------------------------------------------- Takt
  update(dt) {
    this.tick++;
    this.time += dt;

    // Phasenuhr
    if (this.phase === C.PHASE_PREP) {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.phase = C.PHASE_HUNT;
        this.phaseTime = C.HUNT_SECONDS;
        this.pushEvent({ k: 'phase', phase: this.phase, round: this.round });
      }
    } else if (this.phase === C.PHASE_HUNT) {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.phaseTime = 0;
        this.endRound(this.aliveHiders.length > 0 ? C.ROLE_HIDER : C.ROLE_SEEKER);
      }
    } else if (this.phase === C.PHASE_OVER) {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        if (this.players.size >= C.MIN_PLAYERS) this.startRound();
        else this.toLobby();
      }
    } else if (this.phase === C.PHASE_LOBBY) {
      if (this.allReady()) this.startRound();
    }

    for (const p of this.players.values()) this.updatePlayer(p, dt);
    this.updateDecoys(dt);
    this.updateSplats(dt);
    this.updateScans(dt);
    this.checkRoundEnd();
  }

  updatePlayer(p, dt) {
    // Abklingzeiten
    p.grappleCd = Math.max(0, p.grappleCd - dt);
    p.decoyCd = Math.max(0, p.decoyCd - dt);
    p.scanCd = Math.max(0, p.scanCd - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.catchCd = Math.max(0, p.catchCd - dt);
    p.stunT = Math.max(0, p.stunT - dt);
    p.markT = Math.max(0, p.markT - dt);
    p.shimmer = Math.max(0, p.shimmer - dt);

    // Gefangen: kurz warten, dann als Jaeger zurueck.
    if (!p.alive) {
      p.respawnT -= dt;
      p.vx = 0; p.vy = 0;
      if (p.respawnT <= 0) {
        this.becomeSeeker(p, true);
        this.pushEvent({ k: 'respawn', id: p.id, name: p.name });
      }
      return;
    }

    const inHunt = this.phase === C.PHASE_HUNT;
    const inPrep = this.phase === C.PHASE_PREP;
    const inLobby = this.phase === C.PHASE_LOBBY;
    const isHider = p.role === C.ROLE_HIDER;
    const isSeeker = p.role === C.ROLE_SEEKER;

    // Jaeger stehen in der Vorbereitung still - die Augen sind verbunden.
    const frozen = (isSeeker && inPrep) || p.stunT > 0 || this.phase === C.PHASE_OVER;
    const inp = frozen ? EMPTY_INPUT : p.input;

    // --- Zungenhaken zieht ---------------------------------------------
    if (p.grapple) {
      const g = p.grapple;
      g.t += dt;
      const dx = g.ax - p.x, dy = g.ay - p.y;
      const dist = Math.hypot(dx, dy);
      const before = { x: p.x, y: p.y };
      if (dist > 1) {
        p.vx = (dx / dist) * C.GRAPPLE_PULL_SPEED;
        p.vy = (dy / dist) * C.GRAPPLE_PULL_SPEED;
        const m = slideMove(this.map, p.x, p.y, p.vx * dt, p.vy * dt);
        p.x = m.x; p.y = m.y;
      }
      const moved = Math.hypot(p.x - before.x, p.y - before.y);
      if (dist <= C.GRAPPLE_RELEASE_DIST || moved < 0.5 || g.t > C.GRAPPLE_MAX_TIME) {
        p.grapple = null;
        p.vx *= 0.35; p.vy *= 0.35;
      }
      p.stillTime = 0; p.lastMoveT = 0;
      this.clearActions(p);
      return;
    }

    // --- Dash (Jaeger) ---------------------------------------------------
    if (p.dashT > 0) {
      p.dashT -= dt;
      p.vx = Math.cos(p.dashDir) * C.DASH_SPEED;
      p.vy = Math.sin(p.dashDir) * C.DASH_SPEED;
      const m = slideMove(this.map, p.x, p.y, p.vx * dt, p.vy * dt);
      p.x = m.x; p.y = m.y;
      p.lastMoveT = 0; p.stillTime = 0;
      this.clearActions(p);
      return;
    }

    // --- Ausdauer und Sprint ------------------------------------------
    let sprintAllowed = false;
    if (isHider && !frozen) {
      const wantsSprint = inp.sprint && (inp.up || inp.down || inp.left || inp.right);
      if (wantsSprint && (p.sprinting ? p.stamina > 0 : p.stamina >= C.STAMINA_SPRINT_MIN)) {
        sprintAllowed = true;
      }
    }

    // --- Farbaufnahme: stillhalten und E halten ------------------------
    const speedNow = Math.hypot(p.vx, p.vy);
    if (isHider && inp.absorb && speedNow < C.ABSORB_MOVE_TOLERANCE && !isSolidAt(this.map, p.x, p.y)) {
      p.absorbing += dt;
      if (p.absorbing >= C.ABSORB_TIME) {
        p.color = tileColorAt(this.map, p.x, p.y).slice();
        p.shimmer = C.CAMO_SHIMMER_TIME;
        p.absorbing = 0;
        this.pushEvent({ k: 'absorb', id: p.id, x: p.x, y: p.y });
      }
    } else {
      p.absorbing = 0;
    }

    // --- Bewegung ------------------------------------------------------
    const moveInput = p.absorbing > 0 ? EMPTY_INPUT : inp;
    const sprinting = stepMovement(p, moveInput, dt, this.map, { sprintAllowed });
    p.sprinting = sprinting;
    const speed = Math.hypot(p.vx, p.vy);

    if (sprinting && speed > 1) {
      p.stamina = Math.max(0, p.stamina - C.STAMINA_DRAIN * dt);
      p.staminaDelay = C.STAMINA_REGEN_DELAY;
      // Farbspur: Sprinten hinterlaesst Kleckse in der eigenen Farbe.
      p.splatT -= dt;
      if (p.splatT <= 0 && inHunt) {
        p.splatT = C.SPLAT_INTERVAL;
        this.addSplat(p.x, p.y, p.color);
      }
    } else {
      p.staminaDelay = Math.max(0, p.staminaDelay - dt);
      if (p.staminaDelay <= 0) p.stamina = Math.min(C.STAMINA_MAX, p.stamina + C.STAMINA_REGEN * dt);
      p.splatT = 0;
    }

    // Stillstand-Zaehler fuer die Tarnung
    if (speed < C.SCAN_MOTION_THRESHOLD) {
      p.stillTime += dt;
      p.lastMoveT += dt;
    } else {
      p.stillTime = 0;
      p.lastMoveT = 0;
    }

    // Ueberlebenspunkte
    if (isHider && inHunt) {
      p.survivePts += C.PTS_SURVIVE_PER_SEC * dt;
      if (p.survivePts >= 1) { const w = Math.floor(p.survivePts); p.roundScore += w; p.survivePts -= w; }
    }

    // --- Aktionen ------------------------------------------------------
    // In der Lobby duerfen Chamaeleons Haken und Koeder ueben; Jaeger gibt es dort nicht.
    const canAct = !frozen && (!inLobby || isHider);
    if (canAct) {
      if (isHider) {
        if (p.actions.grapple && p.grappleCd <= 0 && p.absorbing <= 0) this.tryGrapple(p);
        if (p.actions.decoy && p.decoyCd <= 0 && (inHunt || inPrep)) this.tryDecoy(p);
      }
      if (isSeeker && inHunt) {
        if (p.actions.primary && p.catchCd <= 0) this.tryCatch(p);
        if (p.actions.scan && p.scanCd <= 0) this.tryScan(p);
        if (p.actions.dash && p.dashCd <= 0) this.tryDash(p, inp);
      }
    }
    this.clearActions(p);
  }

  clearActions(p) {
    for (const k of Object.keys(p.actions)) p.actions[k] = false;
  }

  // ---------------------------------------------------------------- Aktionen
  tryGrapple(p) {
    // Anker in Zielrichtung suchen: nah am Zielwinkel, in Reichweite, freie Bahn.
    let best = null, bestScore = Infinity;
    for (const a of this.map.anchors) {
      const dx = a.x - p.x, dy = a.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > C.GRAPPLE_RANGE || dist < C.TILE) continue;
      const ang = Math.atan2(dy, dx);
      const off = Math.abs(angleDiff(p.aim, ang));
      if (off > 0.32) continue;
      const score = off * 200 + dist * 0.15;
      if (score >= bestScore) continue;
      // Bahn bis kurz vor die Saeule muss frei sein.
      const tx = a.x - (dx / dist) * (C.TILE * 0.72);
      const ty = a.y - (dy / dist) * (C.TILE * 0.72);
      if (raycastSolid(this.map, p.x, p.y, tx, ty)) continue;
      best = a; bestScore = score;
    }
    if (!best) { this.pushEvent({ k: 'grapplemiss', id: p.id }); return; }
    p.grapple = { ax: best.x, ay: best.y, t: 0 };
    p.grappleCd = C.GRAPPLE_COOLDOWN;
    p.absorbing = 0;
    this.pushEvent({ k: 'grapple', id: p.id, x: p.x, y: p.y, ax: best.x, ay: best.y });
  }

  tryDecoy(p) {
    const own = this.decoys.filter((d) => d.owner === p.id).length;
    if (own >= C.DECOY_MAX_PER_PLAYER) return;
    if (isSolidAt(this.map, p.x, p.y)) return;
    this.decoys.push({
      id: 'd' + (nextEntityId++), x: p.x, y: p.y, color: p.color.slice(),
      owner: p.id, t: C.DECOY_LIFETIME,
    });
    p.decoyCd = C.DECOY_COOLDOWN;
    this.pushEvent({ k: 'decoy', id: p.id });
  }

  /** Zungenschlag des Jaegers: naechstes Ziel im Kegel vor ihm. */
  tryCatch(p) {
    p.catchCd = C.CATCH_COOLDOWN;
    let target = null, targetDist = Infinity, isDecoy = false;
    const consider = (x, y, obj, decoy) => {
      const dx = x - p.x, dy = y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > C.CATCH_RANGE + C.PLAYER_RADIUS) return;
      if (dist > 4 && Math.abs(angleDiff(p.aim, Math.atan2(dy, dx))) > C.CATCH_ARC / 2) return;
      if (dist >= targetDist) return;
      if (raycastSolid(this.map, p.x, p.y, x, y, 5)) return;
      target = obj; targetDist = dist; isDecoy = decoy;
    };
    for (const h of this.players.values()) {
      if (h.role !== C.ROLE_HIDER || !h.alive) continue;
      consider(h.x, h.y, h, false);
    }
    for (const d of this.decoys) consider(d.x, d.y, d, true);

    this.pushEvent({ k: 'lash', id: p.id, x: p.x, y: p.y, aim: p.aim, hit: !!target });
    if (!target) return;

    if (isDecoy) {
      this.decoys = this.decoys.filter((d) => d !== target);
      p.stunT = C.DECOY_STUN;
      const owner = this.players.get(target.owner);
      if (owner) owner.roundScore += C.PTS_DECOY_HIT;
      this.pushEvent({ k: 'decoypop', x: target.x, y: target.y, by: p.id, owner: target.owner });
      return;
    }
    target.alive = false;
    target.respawnT = C.RESPAWN_SECONDS;
    target.grapple = null;
    target.absorbing = 0;
    target.vx = 0; target.vy = 0;
    p.roundScore += C.PTS_CATCH;
    p.catches++;
    this.pushEvent({
      k: 'catch', by: p.id, byName: p.name, who: target.id, whoName: target.name,
      x: target.x, y: target.y, left: this.aliveHiders.length,
    });
  }

  tryScan(p) {
    p.scanCd = C.SCAN_COOLDOWN;
    this.scans.push({ id: 's' + (nextEntityId++), x: p.x, y: p.y, r: 0, t: 0, hit: new Set() });
    this.pushEvent({ k: 'scan', id: p.id, x: p.x, y: p.y });
  }

  tryDash(p, inp) {
    let ix = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let iy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    p.dashDir = (ix || iy) ? Math.atan2(iy, ix) : p.aim;
    p.dashT = C.DASH_TIME;
    p.dashCd = C.DASH_COOLDOWN;
    this.pushEvent({ k: 'dash', id: p.id, x: p.x, y: p.y });
  }

  addSplat(x, y, color) {
    this.splats.push({ x, y, color: color.slice(), t: C.SPLAT_LIFETIME, seed: (this.rng() * 1000) | 0 });
    if (this.splats.length > C.SPLAT_MAX) this.splats.splice(0, this.splats.length - C.SPLAT_MAX);
  }

  // ---------------------------------------------------------------- Welt
  updateDecoys(dt) {
    for (const d of this.decoys) d.t -= dt;
    const gone = this.decoys.filter((d) => d.t <= 0);
    for (const d of gone) this.pushEvent({ k: 'decoyfade', x: d.x, y: d.y, owner: d.owner });
    if (gone.length) this.decoys = this.decoys.filter((d) => d.t > 0);
  }

  updateSplats(dt) {
    for (const s of this.splats) s.t -= dt;
    this.splats = this.splats.filter((s) => s.t > 0);
  }

  /** Die Scan-Welle breitet sich aus und markiert alles, was sich juengst bewegt hat. */
  updateScans(dt) {
    for (const s of this.scans) {
      s.t += dt;
      s.r = Math.min(C.SCAN_RADIUS, s.t * C.SCAN_SPEED);
      for (const h of this.players.values()) {
        if (h.role !== C.ROLE_HIDER || !h.alive || s.hit.has(h.id)) continue;
        const d = Math.hypot(h.x - s.x, h.y - s.y);
        if (d > s.r) continue;
        s.hit.add(h.id);
        if (h.lastMoveT < C.SCAN_MOTION_WINDOW) {
          h.markT = C.SCAN_MARK_TIME;
          this.pushEvent({ k: 'scanhit', id: h.id, x: h.x, y: h.y });
        }
      }
    }
    this.scans = this.scans.filter((s) => s.r < C.SCAN_RADIUS);
  }

  // ---------------------------------------------------------------- Ausgabe
  /** Was ein bestimmter Spieler in diesem Takt sehen darf. */
  snapshotFor(id) {
    const me = this.players.get(id);
    if (!me) return null;
    const seesLikeSeeker = me.role === C.ROLE_SEEKER || !me.alive;
    const list = [];

    for (const p of this.players.values()) {
      if (p.id === id) continue;
      const dist = Math.hypot(p.x - me.x, p.y - me.y);
      if (dist > C.VIEW_RADIUS) continue;
      let alpha = 1;
      let name = p.name;
      if (p.role === C.ROLE_HIDER) {
        if (!p.alive) continue;               // Gefangene verschwinden kurz
        if (seesLikeSeeker) {
          const base = baseVisibility(this.map, p);
          alpha = visibilityForSeeker(base, dist, p.markT);
          if (alpha < C.SEND_ALPHA_MIN) continue;
          name = null;                        // Jaeger sehen keine Namen von Chamaeleons
          alpha = Math.round(alpha * 100) / 100;
        }
      }
      list.push(this.publicView(p, alpha, name));
    }

    // Koeder: fuer Jaeger als scheinbar stilles Chamaeleon getarnt, ohne Namen.
    for (const d of this.decoys) {
      const dist = Math.hypot(d.x - me.x, d.y - me.y);
      if (dist > C.VIEW_RADIUS) continue;
      if (seesLikeSeeker) {
        const fake = { x: d.x, y: d.y, color: d.color, stillTime: 99, shimmer: 0 };
        const alpha = visibilityForSeeker(baseVisibility(this.map, fake), dist, 0);
        if (alpha < C.SEND_ALPHA_MIN) continue;
        list.push({
          id: d.id, name: null, x: r1(d.x), y: r1(d.y), aim: 0, role: C.ROLE_HIDER,
          color: d.color, alpha: Math.round(alpha * 100) / 100,
          stun: 0, grapple: null, absorbing: false, sprint: false, mark: false, decoy: false, still: true,
        });
      } else {
        list.push({
          id: d.id, name: 'Köder', x: r1(d.x), y: r1(d.y), aim: 0, role: C.ROLE_HIDER,
          color: d.color, alpha: 1, stun: 0, grapple: null, absorbing: false, sprint: false,
          mark: false, decoy: true, still: true, owner: d.owner, life: Math.round(d.t),
        });
      }
    }

    const events = this.events.filter((ev) => this.eventVisibleTo(ev, me));

    return {
      t: 'state',
      tick: this.tick,
      seq: me.seq,
      phase: this.phase,
      timeLeft: Math.max(0, Math.round(this.phaseTime * 10) / 10),
      round: this.round,
      hidersLeft: this.aliveHiders.length,
      hidersTotal: this.hidersTotal,
      seekers: this.seekers.length,
      winner: this.lastWinner,
      you: {
        id: me.id, x: r1(me.x), y: r1(me.y), vx: r1(me.vx), vy: r1(me.vy), aim: me.aim,
        role: me.role, alive: me.alive, color: me.color,
        stamina: Math.round(me.stamina), absorb: Math.round((me.absorbing / C.ABSORB_TIME) * 100) / 100,
        cd: {
          grapple: r1(me.grappleCd), decoy: r1(me.decoyCd), scan: r1(me.scanCd),
          dash: r1(me.dashCd), catch: r1(me.catchCd),
        },
        stun: r1(me.stunT), mark: r1(me.markT), respawn: r1(me.respawnT),
        vis: me.role === C.ROLE_HIDER ? Math.round(baseVisibility(this.map, me) * 100) / 100 : 1,
        grapple: me.grapple ? { ax: me.grapple.ax, ay: me.grapple.ay } : null,
        score: me.score, roundScore: Math.round(me.roundScore), catches: me.catches,
        sprint: me.sprinting, ready: me.ready,
      },
      players: list,
      splats: this.splats
        .filter((s) => Math.hypot(s.x - me.x, s.y - me.y) < C.VIEW_RADIUS)
        .map((s) => ({ x: r1(s.x), y: r1(s.y), c: s.color, t: r1(s.t), s: s.seed })),
      scans: this.scans.map((s) => ({ x: r1(s.x), y: r1(s.y), r: r1(s.r) })),
      events,
    };
  }

  publicView(p, alpha, name) {
    return {
      id: p.id, name, x: r1(p.x), y: r1(p.y), aim: Math.round(p.aim * 100) / 100,
      role: p.role, alive: p.alive, color: p.color, alpha,
      stun: r1(p.stunT), grapple: p.grapple ? { ax: p.grapple.ax, ay: p.grapple.ay } : null,
      absorbing: p.absorbing > 0, sprint: p.sprinting, mark: p.markT > 0,
      dash: p.dashT > 0, decoy: false, still: p.stillTime > C.CAMO_STILL_RAMP,
    };
  }

  /** Ereignisse mit Positionsangaben werden fuer Jaeger nur in Sichtweite geliefert. */
  eventVisibleTo(ev, me) {
    if (ev.x === undefined) return true;
    if (me.role !== C.ROLE_SEEKER && me.alive) return true;
    if (ev.k === 'absorb' && ev.id !== me.id) {
      // Das Flimmern sieht ein Jaeger nur aus der Naehe.
      return Math.hypot(ev.x - me.x, ev.y - me.y) < C.REVEAL_RADIUS * 3;
    }
    return Math.hypot(ev.x - me.x, ev.y - me.y) < C.VIEW_RADIUS;
  }

  /** Tabelle fuer Lobby und Anzeigetafel - fuer alle gleich. */
  scoreboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((p) => ({
        id: p.id, name: p.name, role: p.role, alive: p.alive, ready: p.ready,
        score: p.score, roundScore: Math.round(p.roundScore), catches: p.catches,
      }));
  }

  flushEvents() { this.events = []; }
}

const r1 = (v) => Math.round(v * 10) / 10;
