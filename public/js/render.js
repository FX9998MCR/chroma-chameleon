// Three.js-Szene: Kamera, Licht, Spielfiguren, Interpolation und Effekte.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { deserializeMap } from '/shared/map.js';
import { lerp, angleDiff } from '/shared/physics.js';
import { makeChameleon, makeSeeker, makeTongue, aimTongue, rgb, GEO } from './models.js';
import { buildWorld, animateWorld } from './world.js';

const U = 1 / C.TILE;    // Pixel -> Einheiten
const UP = new THREE.Vector3(0, 1, 0);

export class Renderer {
  constructor(container, labelsEl) {
    this.container = container;
    this.labelsEl = labelsEl;
    // Leistungsmodus: per URL (?lowfx) oder Einstellung - fuer schwache Rechner.
    this.lowFx = new URLSearchParams(location.search).has('lowfx') || localStorage.getItem('cc-lowfx') === '1';
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.lowFx, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.lowFx ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.lowFx;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f14);
    this.scene.fog = new THREE.Fog(0x0b0f14, 26, 44);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    this.camTarget = new THREE.Vector3();
    // Steil von oben, damit Mauern die eigene Figur moeglichst nie verdecken.
    this.camOffset = new THREE.Vector3(0, 17.5, 6.5);

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x22301f, 0.75));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 80;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.map = null;
    this.world = null;
    this.entities = new Map();    // id -> Entity
    this.me = null;               // eigene Figur
    this.meKind = null;
    this.tongues = new Map();     // id -> Zunge (Haken)
    this.lashes = [];             // kurze Zungenschlaege
    this.rings = new Map();       // scan id -> Ring
    this.splats = new Map();
    this.particles = [];
    this.particlePool = [];
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(UP, 0);
    this.clock = 0;
    this.lookLean = new THREE.Vector3();

    this.absorbRing = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.62, 32),
      new THREE.MeshBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.absorbRing.rotation.x = -Math.PI / 2;
    this.absorbRing.position.y = 0.02;
    this.scene.add(this.absorbRing);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setLowFx(on) {
    this.lowFx = on;
    this.renderer.setPixelRatio(on ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !on;
    // Materialien muessen neu kompiliert werden, damit der Schattenwechsel greift.
    this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMap(raw) {
    if (this.world) this.scene.remove(this.world.group);
    this.map = deserializeMap(raw);
    this.world = buildWorld(this.scene, this.map);
    this.camTarget.set(this.map.w / 2, 0, this.map.h / 2);
  }

  /** Bildschirmpunkt -> Weltkoordinate in Pixeln (2D-Spielkoordinaten). */
  screenToWorld(mx, my) {
    const ndc = new THREE.Vector2((mx / window.innerWidth) * 2 - 1, -(my / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return { x: hit.x * C.TILE, y: hit.z * C.TILE };
  }

  // ---------------------------------------------------------------- Figuren
  makeModel(role, color) {
    return role === C.ROLE_SEEKER ? makeSeeker() : makeChameleon(color);
  }

  ensureEntity(id, role, color, name) {
    let e = this.entities.get(id);
    if (e && e.role !== role) { this.removeEntity(id); e = null; }
    if (!e) {
      const group = this.makeModel(role, color);
      this.scene.add(group);
      e = {
        id, role, group, name, buf: [], alpha: 0, targetAlpha: 1, phase: Math.random() * 6,
        color: color.slice(), lastSeen: 0, labelEl: null, x: 0, y: 0, aim: 0, cur: null,
        mark: false, stun: 0, decoy: false, grapple: null, sprint: false, dash: false, absorbing: false,
      };
      this.entities.set(id, e);
      this.setOpacity(group, 0);
    }
    return e;
  }

  removeEntity(id) {
    const e = this.entities.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    this.disposeGroup(e.group);
    if (e.labelEl) e.labelEl.remove();
    const t = this.tongues.get(id);
    if (t) { this.scene.remove(t); this.tongues.delete(id); }
    this.entities.delete(id);
  }

  disposeGroup(g) {
    g.traverse((o) => {
      if (o.isMesh) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      }
    });
  }

  setColor(e, color) {
    if (e.color[0] === color[0] && e.color[1] === color[1] && e.color[2] === color[2]) return;
    e.color = color.slice();
    const mats = e.group.userData.mats;
    if (mats?.[0]) mats[0].color.copy(rgb(color));
    if (mats?.[1]) mats[1].color.copy(rgb(color).offsetHSL(0, -0.05, 0.12));
  }

  setOpacity(group, a) {
    group.traverse((o) => {
      if (!o.isMesh || o.userData.hud) return;
      const m = o.material;
      if (!m) return;
      const isHud = o === group.userData.ring || o === group.userData.mark;
      if (isHud) return;
      m.transparent = a < 0.999 || m.userData.alwaysTransparent === true;
      m.opacity = a;
      o.visible = a > 0.01;
    });
  }

  /** Neuer Server-Snapshot: Puffer fuer Interpolation fuellen. */
  pushSnapshot(state, now) {
    const seen = new Set();
    for (const p of state.players) {
      const e = this.ensureEntity(p.id, p.role, p.color, p.name);
      e.name = p.name;
      e.lastSeen = now;
      e.targetAlpha = p.alpha;
      e.mark = !!p.mark;
      e.stun = p.stun || 0;
      e.decoy = !!p.decoy;
      e.grapple = p.grapple;
      e.sprint = !!p.sprint;
      e.dash = !!p.dash;
      e.absorbing = !!p.absorbing;
      e.life = p.life;
      if (e.role === C.ROLE_HIDER) this.setColor(e, p.color);
      e.buf.push({ t: now, x: p.x, y: p.y, aim: p.aim });
      if (e.buf.length > 12) e.buf.shift();
      seen.add(p.id);
    }
    // Nicht mehr gesendete Figuren ausblenden (Tarnung / ausser Sicht).
    for (const e of this.entities.values()) {
      if (!seen.has(e.id)) e.targetAlpha = 0;
    }
    // Scan-Ringe
    const liveScans = new Set();
    for (const s of state.scans) {
      liveScans.add(s.id);
      let r = this.rings.get(s.id);
      if (!r) {
        r = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 72), new THREE.MeshBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.08, depthWrite: false }));
        disc.rotation.x = -Math.PI / 2;
        r.add(ring); r.add(disc);
        r.position.set(s.x * U, 0.04, s.y * U);
        r.userData = { ring, disc, r: 0, target: 0 };
        this.scene.add(r);
        this.rings.set(s.id, r);
      }
      r.userData.target = s.r * U;
    }
    for (const [id, r] of this.rings) {
      if (!liveScans.has(id)) r.userData.fading = true;
    }
    // Farbkleckse
    const liveSplats = new Set();
    for (const s of state.splats) {
      const key = `${s.x},${s.y},${s.s}`;
      liveSplats.add(key);
      let m = this.splats.get(key);
      if (!m) {
        m = new THREE.Mesh(GEO.splat, new THREE.MeshBasicMaterial({ color: rgb(s.c), transparent: true, opacity: 0.8, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = (s.s % 360) * Math.PI / 180;
        const sc = 0.7 + (s.s % 7) * 0.08;
        m.scale.set(sc, sc * (0.7 + (s.s % 5) * 0.1), 1);
        m.position.set(s.x * U, 0.018 + (s.s % 10) * 0.0005, s.y * U);
        this.scene.add(m);
        this.splats.set(key, m);
      }
      m.material.opacity = Math.min(0.85, s.t / 3);
    }
    for (const [key, m] of this.splats) {
      if (!liveSplats.has(key)) { this.scene.remove(m); m.material.dispose(); this.splats.delete(key); }
    }
  }

  /** Eigene Figur anlegen/aktualisieren. */
  ensureMe(role, color) {
    if (this.me && this.meKind !== role) { this.scene.remove(this.me); this.disposeGroup(this.me); this.me = null; }
    if (!this.me) {
      this.me = this.makeModel(role, color);
      this.meKind = role;
      this.meColor = color.slice();
      this.mePhase = 0;
      this.scene.add(this.me);
    }
    if (role === C.ROLE_HIDER && (this.meColor[0] !== color[0] || this.meColor[1] !== color[1] || this.meColor[2] !== color[2])) {
      this.meColor = color.slice();
      const mats = this.me.userData.mats;
      mats[0].color.copy(rgb(color));
      mats[1].color.copy(rgb(color).offsetHSL(0, -0.05, 0.12));
    }
  }

  // ---------------------------------------------------------------- Effekte
  burst(x, y, color, n = 14, speed = 3) {
    const col = Array.isArray(color) ? rgb(color) : new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      let m = this.particlePool.pop();
      if (!m) m = new THREE.Mesh(GEO.particle, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      m.material.color.copy(col);
      m.material.opacity = 1;
      m.position.set(x * U, 0.3, y * U);
      const a = Math.random() * Math.PI * 2, sp = speed * (0.4 + Math.random() * 0.8);
      m.userData = { vx: Math.cos(a) * sp, vy: 2 + Math.random() * 3, vz: Math.sin(a) * sp, life: 0.6 + Math.random() * 0.4, max: 1 };
      m.userData.max = m.userData.life;
      m.scale.setScalar(0.7 + Math.random() * 0.8);
      this.scene.add(m);
      this.particles.push(m);
    }
  }

  lash(x, y, aim, hit) {
    const t = makeTongue(hit ? 0xff4d6d : 0xff7aa2);
    const a = new THREE.Vector3(x * U, 0.42, y * U);
    const len = (C.CATCH_RANGE + 10) * U;
    const b = new THREE.Vector3(a.x + Math.cos(aim) * len, 0.42, a.z + Math.sin(aim) * len);
    aimTongue(t, a, b);
    t.userData.life = 0.16;
    this.scene.add(t);
    this.lashes.push(t);
  }

  // ---------------------------------------------------------------- Frame
  /**
   * @param {object} f {dt, now, me:{x,y,aim,role,alive,color,vis,grapple,absorb,stun,mark,sprint,dash,speed}, phase, meId, blind}
   */
  update(f) {
    const dt = Math.min(f.dt, 0.05);
    this.clock += dt;
    const renderT = f.now - C.INTERP_DELAY_MS;

    // Eigene Figur
    if (f.me) {
      this.ensureMe(f.me.role, f.me.color);
      const g = this.me;
      g.position.set(f.me.x * U, 0, f.me.y * U);
      const targetRot = -f.me.aim;
      g.rotation.y += angleDiff(g.rotation.y, targetRot) * Math.min(1, dt * 14);
      this.animate(g, f.me.speed ?? 0, dt, f.me.stun > 0);
      // Eigene Sichtbarkeit als Feedback: getarnt = durchscheinend.
      const selfAlpha = f.me.role === C.ROLE_HIDER ? 0.45 + 0.55 * f.me.vis : 1;
      this.setOpacity(g, f.me.alive ? selfAlpha : 0);
      // Eigener Ring immer sichtbar - auch wenn eine Mauer davor steht.
      const ring = g.userData.ring;
      ring.material.opacity = 0.85;
      ring.material.depthTest = false;
      ring.renderOrder = 999;
      ring.material.color.set(f.me.role === C.ROLE_SEEKER ? 0xff8c42 : 0x7ee787);
      if (g.userData.mark) g.userData.mark.material.opacity = f.me.mark > 0 ? 0.5 + Math.sin(this.clock * 12) * 0.4 : 0;
      // Haken-Zunge
      this.updateTongue('me', f.me.grapple, g.position, f.me.aim);
      // Farbaufnahme-Ring
      if (f.me.absorb > 0) {
        this.absorbRing.position.set(g.position.x, 0.02, g.position.z);
        this.absorbRing.material.opacity = 0.35 + f.me.absorb * 0.6;
        this.absorbRing.scale.setScalar(1.4 - f.me.absorb * 0.5);
        this.absorbRing.rotation.z += dt * 4;
      } else this.absorbRing.material.opacity = 0;
      if (this.me.userData.visor) this.me.userData.visor.material.emissiveIntensity = f.me.stun > 0 ? 0.1 : 0.9;
    }

    // Andere Figuren: interpolieren, ein-/ausblenden
    for (const e of this.entities.values()) {
      const pos = this.sample(e.buf, renderT);
      if (pos) {
        if (!e.cur) e.cur = { x: pos.x, y: pos.y, aim: pos.aim };
        const speed = Math.hypot(pos.x - e.cur.x, pos.y - e.cur.y) / Math.max(dt, 1e-3);
        e.cur.x = pos.x; e.cur.y = pos.y;
        e.cur.aim += angleDiff(e.cur.aim, pos.aim) * Math.min(1, dt * 12);
        e.group.position.set(pos.x * U, 0, pos.y * U);
        e.group.rotation.y = -e.cur.aim;
        e.speedEst = lerp(e.speedEst ?? 0, Math.min(speed, 400), 0.3);
      }
      e.alpha += (e.targetAlpha - e.alpha) * Math.min(1, dt * (e.targetAlpha > e.alpha ? 9 : 5));
      if (f.now - e.lastSeen > 2500 && e.alpha < 0.02) { this.removeEntity(e.id); continue; }
      this.setOpacity(e.group, e.alpha);
      this.animate(e.group, e.speedEst ?? 0, dt, e.stun > 0);
      const ud = e.group.userData;
      const friendly = f.me && (e.role === C.ROLE_SEEKER ? f.me.role === C.ROLE_SEEKER : f.me.role === C.ROLE_HIDER);
      ud.ring.material.opacity = friendly ? 0.45 * e.alpha : 0;
      if (ud.mark) ud.mark.material.opacity = e.mark ? (0.5 + Math.sin(this.clock * 12) * 0.4) * e.alpha : 0;
      if (ud.visor) ud.visor.material.emissiveIntensity = e.stun > 0 ? 0.1 : 0.9;
      this.updateTongue(e.id, e.grapple, e.group.position, e.cur?.aim ?? 0, e.alpha);
      this.updateLabel(e, f);
    }

    // Kamera folgt weich, mit leichtem Blick in Zielrichtung
    if (f.me) {
      const lean = f.me.lean ?? { x: 0, y: 0 };
      this.lookLean.lerp(new THREE.Vector3(lean.x * U, 0, lean.y * U), Math.min(1, dt * 4));
      const want = new THREE.Vector3(f.me.x * U, 0, f.me.y * U).add(this.lookLean);
      this.camTarget.lerp(want, Math.min(1, dt * 7));
    }
    this.camera.position.copy(this.camTarget).add(this.camOffset);
    this.camera.lookAt(this.camTarget.x, 0.3, this.camTarget.z);
    this.sun.position.set(this.camTarget.x + 9, 22, this.camTarget.z + 6);
    this.sun.target.position.copy(this.camTarget);

    // Scan-Ringe
    for (const [id, r] of this.rings) {
      const ud = r.userData;
      ud.r += (ud.target - ud.r) * Math.min(1, dt * 12);
      if (ud.fading) ud.r += dt * C.SCAN_SPEED * U;
      const s = Math.max(0.01, ud.r);
      r.scale.set(s, s, s);
      const frac = Math.min(1, ud.r / (C.SCAN_RADIUS * U));
      ud.ring.material.opacity = 0.9 * (1 - frac * frac);
      ud.disc.material.opacity = 0.10 * (1 - frac);
      if (frac >= 0.999) { this.scene.remove(r); this.rings.delete(id); }
    }

    // Zungenschlaege
    for (let i = this.lashes.length - 1; i >= 0; i--) {
      const t = this.lashes[i];
      t.userData.life -= dt;
      if (t.userData.life <= 0) { this.scene.remove(t); this.disposeGroup(t); this.lashes.splice(i, 1); }
    }

    // Partikel
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const m = this.particles[i], u = m.userData;
      u.life -= dt;
      u.vy -= 9 * dt;
      m.position.x += u.vx * dt; m.position.y += u.vy * dt; m.position.z += u.vz * dt;
      if (m.position.y < 0.05) { m.position.y = 0.05; u.vy *= -0.3; u.vx *= 0.7; u.vz *= 0.7; }
      m.material.opacity = Math.max(0, u.life / u.max);
      if (u.life <= 0) { this.scene.remove(m); this.particles.splice(i, 1); this.particlePool.push(m); }
    }

    if (this.world) animateWorld(this.world, this.clock);
    this.renderer.render(this.scene, this.camera);
  }

  /** Position zum Zeitpunkt t aus dem Puffer interpolieren. */
  sample(buf, t) {
    if (buf.length === 0) return null;
    if (buf.length === 1 || t <= buf[0].t) return buf[0];
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i], b = buf[i + 1];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), aim: a.aim + angleDiff(a.aim, b.aim) * k };
      }
    }
    // Ueber das Ende hinaus: kurz extrapolieren, dann stehen bleiben.
    const a = buf[buf.length - 2], b = buf[buf.length - 1];
    const k = Math.min(1.5, (t - b.t) / Math.max(1, b.t - a.t));
    return { x: b.x + (b.x - a.x) * k * 0.5, y: b.y + (b.y - a.y) * k * 0.5, aim: b.aim };
  }

  animate(g, speed, dt, stunned) {
    const ud = g.userData;
    ud.phase = (ud.phase ?? 0) + dt * (2 + speed * 0.045);
    const sw = Math.min(1, speed / 120);
    ud.legs?.forEach((leg, i) => {
      const dir = i % 2 === 0 ? 1 : -1;
      const front = i < 2 ? 1 : -1;
      leg.rotation.z = Math.sin(ud.phase * 2 + (i < 2 ? 0 : Math.PI)) * 0.55 * sw * dir * front;
    });
    if (ud.torso) ud.torso.position.y = (ud.kind === 'seeker' ? 0.40 : 0.28) + Math.abs(Math.sin(ud.phase * 2)) * 0.03 * sw + (ud.kind === 'seeker' ? 0 : Math.sin(ud.phase) * 0.006);
    if (ud.tail) ud.tail.rotation.x = Math.sin(ud.phase * 1.3) * 0.25;
    if (ud.head) ud.head.rotation.y = stunned ? Math.sin(ud.phase * 6) * 0.5 : Math.sin(ud.phase * 0.7) * 0.12;
    g.rotation.z = stunned ? Math.sin(ud.phase * 5) * 0.15 : 0;
  }

  updateTongue(id, grapple, pos, aim, alpha = 1) {
    let t = this.tongues.get(id);
    if (!grapple) {
      if (t) { this.scene.remove(t); this.disposeGroup(t); this.tongues.delete(id); }
      return;
    }
    if (!t) { t = makeTongue(); this.scene.add(t); this.tongues.set(id, t); }
    const a = new THREE.Vector3(pos.x + Math.cos(aim) * 0.4, 0.4, pos.z + Math.sin(aim) * 0.4);
    const b = new THREE.Vector3(grapple.ax * U, 1.5, grapple.ay * U);
    aimTongue(t, a, b);
    t.userData.mesh.material.opacity = alpha; t.userData.mesh.material.transparent = alpha < 1;
    t.userData.tip.material.opacity = alpha; t.userData.tip.material.transparent = alpha < 1;
  }

  updateLabel(e, f) {
    const show = e.name && e.alpha > 0.15;
    if (!show) { if (e.labelEl) { e.labelEl.style.display = 'none'; } return; }
    if (!e.labelEl) {
      e.labelEl = document.createElement('div');
      this.labelsEl.appendChild(e.labelEl);
    }
    const cls = e.decoy ? 'decoy' : e.role === C.ROLE_SEEKER ? 'seeker' : '';
    e.labelEl.className = `label ${cls}`;
    e.labelEl.textContent = e.decoy ? `Köder ${e.life ?? ''}s` : e.name;
    const v = new THREE.Vector3(e.group.position.x, 0.95, e.group.position.z).project(this.camera);
    if (v.z > 1) { e.labelEl.style.display = 'none'; return; }
    e.labelEl.style.display = '';
    e.labelEl.style.opacity = String(Math.min(1, e.alpha * 1.5));
    e.labelEl.style.left = `${(v.x + 1) / 2 * window.innerWidth}px`;
    e.labelEl.style.top = `${(1 - v.y) / 2 * window.innerHeight}px`;
  }

  clearAll() {
    for (const id of [...this.entities.keys()]) this.removeEntity(id);
    for (const [id, r] of this.rings) { this.scene.remove(r); this.rings.delete(id); }
    for (const [k, m] of this.splats) { this.scene.remove(m); this.splats.delete(k); }
  }
}
