// Autoritative Spielsimulation eines Raums.
// Der Server rechnet Bewegung, Treffer und Runden; Clients schicken Eingaben.
// Tarnung ist rein visuell: Jeder sieht jede Figur in Sichtweite - ob man sie
// im Bild erkennt, entscheidet die Bemalung. Wie im Vorbild.

import * as C from '../shared/constants.js';
import { isSolidAt, TILE_PX } from '../shared/map.js';
import {
  angleDiff, stepMovement, raycast3D, rayHitsCylinder, dirFromAngles, slideMove, raycastSolid,
} from '../shared/physics.js';

const EMPTY_INPUT = Object.freeze({
  up: false, down: false, left: false, right: false, sprint: false, paint: false,
});

let nextEntityId = 1;

/** Zustand eines Spielers auf dem Server. */
export function makePlayer(id, name) {
  return {
    id, name,
    role: C.ROLE_HIDER,
    alive: true,
    x: 0, y: 0, vx: 0, vy: 0,
    yaw: 0, pitch: 0,              // Blickrichtung (Kamera)
    pose: 0,                       // Index in POSES
    painting: false,               // Malmodus aktiv (eingefroren)
    paint: null,                   // letzte Bemalung: {png} oder {fill:[r,g,b]} oder null = weiss
    avgColor: [245, 245, 245],     // Durchschnittsfarbe der Bemalung (fuer Bots)
    stillTime: 0,
    stamina: C.STAMINA_MAX,
    staminaDelay: 0,
    sprinting: false,
    decoyCd: 0, dashCd: 0, shotCd: 0,
    dashT: 0, dashDir: 0,
    stunT: 0,
    respawnT: 0,
    splatT: 0,
    score: 0,
    roundScore: 0,
    survivePts: 0,
    catches: 0,
    seekerRounds: 0,
    bot: false,
    ready: false,
    input: { ...EMPTY_INPUT },
    actions: { primary: false, decoy: false, dash: false, pose: false },
    seq: 0,
  };
}

export class Game {
  constructor(map, opts = {}) {
    this.map = map;
    this.rng = opts.rng ?? Math.random;
    this.players = new Map();
    this.phase = C.PHASE_LOBBY;
    this.phaseTime = 0;
    this.round = 0;
    this.tick = 0;
    this.time = 0;
    this.decoys = [];           // {id, x, y, yaw, pose, paint, avgColor, owner, t}
    this.splats = [];           // Farbspuren am Boden {x, y, color, t, seed}
    this.events = [];
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
    if (this.phase === C.PHASE_PREP || this.phase === C.PHASE_HUNT) this.becomeSeeker(p, true);
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

  setInput(id, inp, actions, look, seq) {
    const p = this.players.get(id);
    if (!p) return;
    p.input = {
      up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
      sprint: !!inp.sprint, paint: !!inp.paint,
    };
    if (look) {
      if (Number.isFinite(look.yaw)) p.yaw = look.yaw;
      if (Number.isFinite(look.pitch)) p.pitch = Math.max(-1.5, Math.min(1.5, look.pitch));
    }
    if (Number.isFinite(seq)) p.seq = seq;
    if (actions) for (const k of Object.keys(p.actions)) if (actions[k]) p.actions[k] = true;
  }

  /** Bemalung eines Spielers setzen (vom Client oder von einem Bot). */
  setPaint(id, paint, avgColor) {
    const p = this.players.get(id);
    if (!p || p.role !== C.ROLE_HIDER) return false;
    p.paint = paint;
    if (Array.isArray(avgColor) && avgColor.length === 3) {
      p.avgColor = avgColor.map((v) => Math.max(0, Math.min(255, Number(v) || 0)));
    }
    return true;
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

  pickSeekerSpawn() {
    const cx = C.WORLD_W / 2, cy = C.WORLD_H / 2;
    let best = null, bestD = Infinity;
    for (const s of this.map.spawns) {
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ?? { x: cx, y: cy };
  }

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
    let humans = 0;
    for (const p of this.players.values()) {
      if (p.bot) continue;
      humans++;
      if (!p.ready) return false;
    }
    return humans > 0;
  }

  startRound() {
    if (this.players.size < C.MIN_PLAYERS) return false;
    this.round++;
    this.phase = C.PHASE_PREP;
    this.phaseTime = C.PREP_SECONDS;
    this.decoys = [];
    this.splats = [];
    this.lastWinner = null;

    const all = [...this.players.values()];
    const seekerCount = Math.max(1, Math.ceil(all.length / C.SEEKER_RATIO));
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
        if (isSolidAt(this.map, p.x, p.y)) { p.x = this.seekerSpawn.x; p.y = this.seekerSpawn.y; }
      } else {
        p.role = C.ROLE_HIDER;
        const s = this.hiderSpawn(used);
        p.x = s.x; p.y = s.y;
      }
      this.pushEvent({ k: 'paint', id: p.id, paint: null });   // alle wieder weiss
    });
    this.hidersTotal = this.hiders.length;
    this.pushEvent({ k: 'phase', phase: this.phase, round: this.round });
    return true;
  }

  resetForRound(p) {
    p.alive = true;
    p.vx = 0; p.vy = 0;
    p.pose = 0; p.painting = false;
    p.paint = null; p.avgColor = [245, 245, 245];
    p.stillTime = 0;
    p.stamina = C.STAMINA_MAX; p.staminaDelay = 0;
    p.decoyCd = 0; p.dashCd = 0; p.shotCd = 0;
    p.dashT = 0; p.stunT = 0; p.respawnT = 0; p.splatT = 0;
    p.roundScore = 0; p.survivePts = 0; p.catches = 0;
    p.actions = { primary: false, decoy: false, dash: false, pose: false };
  }

  becomeSeeker(p, immediate = false) {
    p.role = C.ROLE_SEEKER;
    p.alive = true;
    p.pose = 0; p.painting = false;
    p.paint = null;
    p.dashCd = 0;
    p.shotCd = immediate ? 1.0 : 0.5;
    p.x = this.seekerSpawn.x;
    p.y = this.seekerSpawn.y;
    p.vx = 0; p.vy = 0;
  }

  ensureSeekerExists() {
    if (this.seekers.length > 0) return;
    const pool = this.aliveHiders;
    if (pool.length <= 1) return;
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
      p.dashT = 0; p.stunT = 0;
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
    this.decoys = []; this.splats = [];
    for (const p of this.players.values()) {
      this.resetForRound(p);
      p.role = C.ROLE_HIDER;
      p.ready = false;
      const s = this.randomSpawn();
      p.x = s.x; p.y = s.y;
      this.pushEvent({ k: 'paint', id: p.id, paint: null });
    }
    this.pushEvent({ k: 'phase', phase: this.phase });
  }

  // ---------------------------------------------------------------- Takt
  update(dt) {
    this.tick++;
    this.time += dt;

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
    this.checkRoundEnd();
  }

  updatePlayer(p, dt) {
    p.decoyCd = Math.max(0, p.decoyCd - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.shotCd = Math.max(0, p.shotCd - dt);
    p.stunT = Math.max(0, p.stunT - dt);

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

    // Malmodus friert die Figur ein (nur Chamaeleons koennen malen).
    p.painting = isHider && p.input.paint;
    const frozen = (isSeeker && inPrep) || p.stunT > 0 || this.phase === C.PHASE_OVER || p.painting;
    const inp = frozen ? EMPTY_INPUT : p.input;

    // Dash (Jaeger)
    if (p.dashT > 0) {
      p.dashT -= dt;
      p.vx = Math.cos(p.dashDir) * C.DASH_SPEED;
      p.vy = Math.sin(p.dashDir) * C.DASH_SPEED;
      const m = slideMove(this.map, p.x, p.y, p.vx * dt, p.vy * dt);
      p.x = m.x; p.y = m.y;
      p.stillTime = 0;
      this.clearActions(p);
      return;
    }

    // Pose wechseln (nur Chamaeleons, nur im Stand)
    if (isHider && p.actions.pose && !frozen) {
      p.pose = (p.pose + 1) % C.POSES.length;
      p.vx = 0; p.vy = 0;
      this.pushEvent({ k: 'pose', id: p.id, pose: p.pose });
    }
    // Bewegungstaste loest jede Pose
    const wantsMove = inp.up || inp.down || inp.left || inp.right;
    if (isHider && p.pose !== 0 && wantsMove) {
      p.pose = 0;
      this.pushEvent({ k: 'pose', id: p.id, pose: 0 });
    }

    let sprintAllowed = false;
    if (isHider && !frozen) {
      const wantsSprint = inp.sprint && wantsMove;
      if (wantsSprint && (p.sprinting ? p.stamina > 0 : p.stamina >= C.STAMINA_SPRINT_MIN)) sprintAllowed = true;
    }

    const sprinting = stepMovement(p, inp, dt, this.map, { sprintAllowed, yaw: p.yaw });
    p.sprinting = sprinting;
    const speed = Math.hypot(p.vx, p.vy);

    if (sprinting && speed > 1) {
      p.stamina = Math.max(0, p.stamina - C.STAMINA_DRAIN * dt);
      p.staminaDelay = C.STAMINA_REGEN_DELAY;
      p.splatT -= dt;
      if (p.splatT <= 0 && inHunt) {
        p.splatT = C.SPLAT_INTERVAL;
        this.addSplat(p.x, p.y, p.avgColor);
      }
    } else {
      p.staminaDelay = Math.max(0, p.staminaDelay - dt);
      if (p.staminaDelay <= 0) p.stamina = Math.min(C.STAMINA_MAX, p.stamina + C.STAMINA_REGEN * dt);
      p.splatT = 0;
    }

    if (speed < 5) p.stillTime += dt; else p.stillTime = 0;

    if (isHider && inHunt) {
      p.survivePts += C.PTS_SURVIVE_PER_SEC * dt;
      if (p.survivePts >= 1) { const w = Math.floor(p.survivePts); p.roundScore += w; p.survivePts -= w; }
    }

    const canAct = !frozen && (!inLobby || isHider);
    if (canAct) {
      if (isHider && p.actions.decoy && p.decoyCd <= 0 && (inHunt || inPrep)) this.tryDecoy(p);
      if (isSeeker && inHunt) {
        if (p.actions.primary && p.shotCd <= 0) this.tryShoot(p);
        if (p.actions.dash && p.dashCd <= 0) this.tryDash(p, inp);
      }
    }
    this.clearActions(p);
  }

  clearActions(p) {
    for (const k of Object.keys(p.actions)) p.actions[k] = false;
  }

  // ---------------------------------------------------------------- Aktionen
  tryDecoy(p) {
    const own = this.decoys.filter((d) => d.owner === p.id).length;
    if (own >= C.DECOY_MAX_PER_PLAYER) return;
    if (isSolidAt(this.map, p.x, p.y)) return;
    const id = 'd' + (nextEntityId++);
    this.decoys.push({
      id, x: p.x, y: p.y, yaw: p.yaw, pose: p.pose, paint: p.paint, avgColor: p.avgColor.slice(),
      owner: p.id, t: C.DECOY_LIFETIME,
    });
    p.decoyCd = C.DECOY_COOLDOWN;
    this.pushEvent({ k: 'decoy', id: p.id });
    this.pushEvent({ k: 'paint', id, paint: p.paint });
  }

  /** Hoehe einer Figur in ihrer aktuellen Pose. */
  static bodyHeight(pose) { return C.POSES[pose]?.h ?? C.BODY_H; }

  /**
   * Farbmarkierer: Strahl aus Augenhoehe entlang der Blickrichtung.
   * Trifft er ein lebendes Chamaeleon oder einen Koeder vor der ersten Mauer,
   * ist das ein Treffer.
   */
  tryShoot(p) {
    p.shotCd = C.SHOT_COOLDOWN;
    // Leichte Streuung, damit Dauerfeuer aus der Ferne nicht trivial ist.
    const yaw = p.yaw + (this.rng() - 0.5) * C.SHOT_SPREAD * 2;
    const pitch = p.pitch + (this.rng() - 0.5) * C.SHOT_SPREAD * 2;
    const o = { x: p.x / TILE_PX, y: p.y / TILE_PX, h: C.EYE_H };
    const d = dirFromAngles(yaw, pitch);
    const wall = raycast3D(this.map, o, d, C.SHOT_RANGE);
    const maxT = wall ? wall.dist : C.SHOT_RANGE;

    let best = null, bestT = maxT, bestDecoy = false;
    for (const h of this.players.values()) {
      if (h.role !== C.ROLE_HIDER || !h.alive) continue;
      const t = rayHitsCylinder(o, d, h.x / TILE_PX, h.y / TILE_PX, C.BODY_R, Game.bodyHeight(h.pose));
      if (t !== null && t < bestT) { best = h; bestT = t; bestDecoy = false; }
    }
    for (const dc of this.decoys) {
      const t = rayHitsCylinder(o, d, dc.x / TILE_PX, dc.y / TILE_PX, C.BODY_R, Game.bodyHeight(dc.pose));
      if (t !== null && t < bestT) { best = dc; bestT = t; bestDecoy = true; }
    }

    const end = { x: o.x + d.x * bestT, y: o.y + d.y * bestT, h: o.h + d.h * bestT };
    this.pushEvent({
      k: 'shot', id: p.id, x: p.x, y: p.y,
      from: { x: o.x, y: o.y, h: o.h }, to: end, hit: !!best,
      wall: !best && wall ? { nx: wall.nx, ny: wall.ny, nh: wall.nh } : null,
    });
    if (!best) return;

    if (bestDecoy) {
      this.decoys = this.decoys.filter((dc) => dc !== best);
      p.stunT = C.DECOY_STUN;
      const owner = this.players.get(best.owner);
      if (owner) owner.roundScore += C.PTS_DECOY_HIT;
      this.pushEvent({ k: 'decoypop', x: best.x, y: best.y, by: p.id, owner: best.owner });
      return;
    }
    best.alive = false;
    best.respawnT = C.RESPAWN_SECONDS;
    best.vx = 0; best.vy = 0;
    best.painting = false;
    p.roundScore += C.PTS_CATCH;
    p.catches++;
    this.pushEvent({
      k: 'catch', by: p.id, byName: p.name, who: best.id, whoName: best.name,
      x: best.x, y: best.y, left: this.aliveHiders.length,
    });
  }

  tryDash(p, inp) {
    const fx = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);
    const sx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (fx || sx) {
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      p.dashDir = Math.atan2(fx * s + sx * c, fx * c - sx * s);
    } else p.dashDir = p.yaw;
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

  // ---------------------------------------------------------------- Ausgabe
  /** Was ein bestimmter Spieler in diesem Takt sieht. */
  snapshotFor(id) {
    const me = this.players.get(id);
    if (!me) return null;
    const seesLikeSeeker = me.role === C.ROLE_SEEKER || !me.alive;
    const list = [];

    for (const p of this.players.values()) {
      if (p.id === id) continue;
      const dist = Math.hypot(p.x - me.x, p.y - me.y);
      if (dist > C.VIEW_RADIUS) continue;
      if (p.role === C.ROLE_HIDER && !p.alive) continue;
      // Jaeger sehen keine Namen von Chamaeleons - sie muessen hinschauen.
      const name = p.role === C.ROLE_HIDER && seesLikeSeeker ? null : p.name;
      list.push(this.publicView(p, name));
    }

    for (const d of this.decoys) {
      const dist = Math.hypot(d.x - me.x, d.y - me.y);
      if (dist > C.VIEW_RADIUS) continue;
      list.push({
        id: d.id, name: seesLikeSeeker ? null : 'Köder', x: r1(d.x), y: r1(d.y), yaw: r2(d.yaw),
        role: C.ROLE_HIDER, alive: true, pose: d.pose, stun: 0, sprint: false, dash: false,
        painting: false, decoy: !seesLikeSeeker, still: true,
        owner: seesLikeSeeker ? undefined : d.owner, life: seesLikeSeeker ? undefined : Math.round(d.t),
      });
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
        id: me.id, x: r1(me.x), y: r1(me.y), vx: r1(me.vx), vy: r1(me.vy),
        role: me.role, alive: me.alive, pose: me.pose, painting: me.painting,
        stamina: Math.round(me.stamina),
        cd: { decoy: r1(me.decoyCd), dash: r1(me.dashCd), shot: r1(me.shotCd) },
        stun: r1(me.stunT), respawn: r1(me.respawnT), dash: me.dashT > 0,
        score: me.score, roundScore: Math.round(me.roundScore), catches: me.catches,
        sprint: me.sprinting, ready: me.ready,
      },
      players: list,
      splats: this.splats
        .filter((s) => Math.hypot(s.x - me.x, s.y - me.y) < C.VIEW_RADIUS)
        .map((s) => ({ x: r1(s.x), y: r1(s.y), c: s.color, t: r1(s.t), s: s.seed })),
      events,
    };
  }

  publicView(p, name) {
    return {
      id: p.id, name, x: r1(p.x), y: r1(p.y), yaw: r2(p.yaw), pitch: r2(p.pitch),
      role: p.role, alive: p.alive, pose: p.pose,
      stun: r1(p.stunT), sprint: p.sprinting, dash: p.dashT > 0, painting: p.painting,
      decoy: false, still: p.stillTime > 0.8,
    };
  }

  /** Ereignisse mit Position: Jaeger bekommen sie nur in Sichtweite. */
  eventVisibleTo(ev, me) {
    if (ev.x === undefined) return true;
    if (me.role !== C.ROLE_SEEKER && me.alive) return true;
    return Math.hypot(ev.x - me.x, ev.y - me.y) < C.VIEW_RADIUS;
  }

  /** Alle aktuellen Bemalungen - fuer Neuankoemmlinge. */
  paintSnapshot() {
    const out = [];
    for (const p of this.players.values()) if (p.paint) out.push({ id: p.id, paint: p.paint });
    for (const d of this.decoys) if (d.paint) out.push({ id: d.id, paint: d.paint });
    return out;
  }

  scoreboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((p) => ({
        id: p.id, name: p.name, role: p.role, alive: p.alive, ready: p.ready || p.bot, bot: p.bot,
        score: p.score, roundScore: Math.round(p.roundScore), catches: p.catches,
      }));
  }

  flushEvents() { this.events = []; }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
