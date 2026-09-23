// Three.js-Szene: Third-Person-Kamera, Figuren, Bemalung, Schuesse, Effekte.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { deserializeMap } from '/shared/map.js';
import { lerp, angleDiff, raycast3D, dirFromAngles, rayHitsBody } from '/shared/physics.js';
import { makeFigure, animateHumanoid, rgb, GEO } from './models.js';
import { buildWorld, animateWorld, disposeWorld } from './world.js';

const U = 1 / C.TILE;
// Geometrien fuer Schusseffekte
GEO.beam = GEO.beam ?? new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true);
GEO.flash = GEO.flash ?? new THREE.SphereGeometry(0.09, 8, 6);

export class Renderer {
  constructor(container, labelsEl) {
    this.container = container;
    this.labelsEl = labelsEl;
    let storedLow = false;
    try { storedLow = localStorage.getItem('cc-lowfx') === '1'; } catch { /* Speicher gesperrt */ }
    this.lowFx = new URLSearchParams(location.search).has('lowfx') || storedLow;
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.lowFx, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.lowFx ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.lowFx;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;      // PCFSoftShadowMap gibt es in r186 nicht mehr
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc3e6);
    // Nebel vor setMap setzen: die Himmelskuppel nimmt fog.color als Horizontfarbe.
    this.scene.fog = new THREE.Fog(0x9fc3e6, 45, 110);

    this.camera = new THREE.PerspectiveCamera(64, 1, 0.05, 150);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.orbit = { yaw: 0, pitch: 0.2, dist: 2.6 };
    this.paintMode = false;

    // Licht so ausbalanciert, dass auch Wandseiten im Schatten ihre Farbe zeigen -
    // man muss Farben ablesen koennen, sonst kann man sich nicht anmalen.
    this.scene.add(new THREE.HemisphereLight(0xdcebff, 0x7d7a62, 1.25));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    this.fill = new THREE.DirectionalLight(0xcfe0ff, 0.45);
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 1.45);
    this.sun.castShadow = true;
    this.sun.shadow.radius = 3;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.map = null;
    this.world = null;
    this.entities = new Map();
    this.me = null;
    this.meKind = null;
    this.tracers = [];
    this.decals = [];
    this.splats = new Map();
    this.particles = [];
    this.particlePool = [];
    this.raycaster = new THREE.Raycaster();
    this.clock = 0;
    this.pendingPaint = new Map();   // id -> paint, falls Figur noch nicht existiert

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setLowFx(on) {
    this.lowFx = on;
    this.renderer.setPixelRatio(on ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !on;
    this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    this.applyDecor();
    this.resize();
  }

  /** Kulisse (Baeume, Bluetenpunkte) nur ohne Leistungsmodus zeigen. */
  applyDecor() {
    this.world?.group.traverse((o) => { if (o.userData.decor) o.visible = !this.lowFx; });
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMap(raw) {
    if (this.world) { this.scene.remove(this.world.group); disposeWorld(this.world); }
    this.map = deserializeMap(raw);
    this.world = buildWorld(this.scene, this.map);
    this.applyDecor();
    // Shader vorab uebersetzen: weniger Ruckeln beim ersten Bild.
    if (this.renderer.extensions.has('KHR_parallel_shader_compile')) this.renderer.compileAsync?.(this.scene, this.camera).catch(() => {});
  }

  // ---------------------------------------------------------------- Picking
  ndc(mx, my) {
    return new THREE.Vector2((mx / window.innerWidth) * 2 - 1, -(my / window.innerHeight) * 2 + 1);
  }

  /** Erster Treffer in der Welt (Boden, Mauern, Buesche, Saeulen) unter dem Cursor. */
  pickWorld(mx, my) {
    if (!this.world) return null;
    this.raycaster.setFromCamera(this.ndc(mx, my), this.camera);
    const hits = this.raycaster.intersectObjects(this.world.pickables, false);
    return hits[0] ?? null;
  }

  /** Treffer auf der eigenen Figur (fuer den Pinsel). */
  pickSelf(mx, my) {
    if (!this.me) return null;
    this.raycaster.setFromCamera(this.ndc(mx, my), this.camera);
    const meshes = Object.values(this.me.userData.parts);
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits[0] ?? null;
  }

  // ---------------------------------------------------------------- Figuren
  ensureEntity(id, role, name) {
    let e = this.entities.get(id);
    if (e && e.role !== role) { this.removeEntity(id); e = null; }
    if (!e) {
      const group = makeFigure(role === C.ROLE_SEEKER ? 'seeker' : 'hider');
      this.scene.add(group);
      e = { id, role, group, name, buf: [], lastSeen: 0, labelEl: null, cur: null, pose: 0, stun: 0, decoy: false, sprint: false, dash: false, painting: false, speedEst: 0 };
      this.entities.set(id, e);
      const pending = this.pendingPaint.get(id);
      if (pending !== undefined) { this.applyPaintTo(group, pending); this.pendingPaint.delete(id); }
    }
    return e;
  }

  removeEntity(id) {
    const e = this.entities.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    this.disposeGroup(e.group);
    if (e.labelEl) e.labelEl.remove();
    this.entities.delete(id);
  }

  disposeGroup(g) {
    const seen = new Set();
    g.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m && !seen.has(m)) { seen.add(m); m.map?.dispose?.(); m.dispose(); } }
      o.geometry?.dispose?.();
    });
  }

  ensureMe(role) {
    if (this.me && this.meKind !== role) { this.scene.remove(this.me); this.disposeGroup(this.me); this.me = null; }
    if (!this.me) {
      this.me = makeFigure(role === C.ROLE_SEEKER ? 'seeker' : 'hider');
      this.meKind = role;
      this.scene.add(this.me);
    }
  }

  /** Bemalung auf eine Figur anwenden: null = weiss, {fill}, {png}. */
  applyPaintTo(group, paint) {
    const ud = group.userData;
    if (!ud?.canvas || ud.kind === 'seeker') return;
    const ctx = ud.canvas.getContext('2d');
    const T = ud.canvas.width;
    if (!paint) {
      ctx.fillStyle = '#f2f2f0'; ctx.fillRect(0, 0, T, T);
      ud.texture.needsUpdate = true;
    } else if (paint.fill) {
      const c = paint.fill;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(0, 0, T, T);
      ud.texture.needsUpdate = true;
    } else if (paint.png) {
      const img = new Image();
      img.onload = () => { ctx.clearRect(0, 0, T, T); ctx.drawImage(img, 0, 0, T, T); ud.texture.needsUpdate = true; };
      img.src = paint.png;
    }
  }

  applyPaint(id, paint, meId) {
    if (id === meId) { if (this.me) this.applyPaintTo(this.me, paint); return; }
    const e = this.entities.get(id);
    if (e) this.applyPaintTo(e.group, paint);
    else this.pendingPaint.set(id, paint);
  }

  pushSnapshot(state, now) {
    const seen = new Set();
    for (const p of state.players) {
      const e = this.ensureEntity(p.id, p.role, p.name);
      e.name = p.name;
      e.lastSeen = now;
      e.pose = p.pose ?? 0;
      e.stun = p.stun || 0;
      e.decoy = !!p.decoy;
      e.sprint = !!p.sprint;
      e.dash = !!p.dash;
      e.painting = !!p.painting;
      e.life = p.life;
      e.buf.push({ t: now, x: p.x, y: p.y, yaw: p.yaw ?? 0, pitch: p.pitch ?? 0 });
      if (e.buf.length > 12) e.buf.shift();
      seen.add(p.id);
    }
    for (const e of this.entities.values()) if (!seen.has(e.id)) e.gone = true; else e.gone = false;

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
        m.position.set(s.x * U, 0.012 + (s.s % 10) * 0.0005, s.y * U);
        this.scene.add(m);
        this.splats.set(key, m);
      }
      m.material.opacity = Math.min(0.85, s.t / 3);
    }
    for (const [key, m] of this.splats) {
      if (!liveSplats.has(key)) { this.scene.remove(m); m.material.dispose(); this.splats.delete(key); }
    }
  }

  // ---------------------------------------------------------------- Effekte
  burst(x, y, color, n = 14, speed = 3, h = 0.8) {
    const col = Array.isArray(color) ? rgb(color) : new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      let m = this.particlePool.pop();
      if (!m) m = new THREE.Mesh(GEO.particle, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      m.material.color.copy(col);
      m.material.opacity = 1;
      m.position.set(x * U, h, y * U);
      const a = Math.random() * Math.PI * 2, sp = speed * (0.4 + Math.random() * 0.8);
      m.userData = { vx: Math.cos(a) * sp, vy: 1.5 + Math.random() * 3, vz: Math.sin(a) * sp, life: 0.6 + Math.random() * 0.4 };
      m.userData.max = m.userData.life;
      m.scale.setScalar(0.7 + Math.random() * 0.8);
      this.scene.add(m);
      this.particles.push(m);
    }
  }

  /**
   * Wohin zeigt das Fadenkreuz? Strahl von der Kamera durch die Bildmitte; der erste
   * Treffer (Mauer, Boden oder Chamaeleon-Figur) ist der Zielpunkt. Zurueck kommt die
   * Richtung von der Augenhoehe der eigenen Figur zu diesem Punkt - genau so schiesst
   * der Server. Ohne diese Korrektur ginge jeder Schuss am Fadenkreuz vorbei, weil die
   * Kamera hinter und neben der Schulter sitzt.
   * @returns {{yaw:number, pitch:number}}
   */
  aimFrom(meX, meY) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const o = { x: this.camera.position.x, y: this.camera.position.z, h: this.camera.position.y };
    const d = { x: dir.x, y: dir.z, h: dir.y };
    const eye = { x: meX * U, y: meY * U, h: C.EYE_H };
    // Nur Treffer VOR der eigenen Figur zaehlen (die Kamera steht dahinter).
    const tMin = Math.max(0, (eye.x - o.x) * d.x + (eye.y - o.y) * d.y + (eye.h - o.h) * d.h);
    const reach = tMin + C.SHOT_RANGE;
    let bestT = reach;
    const wall = this.map ? raycast3D(this.map, o, d, reach) : null;
    if (wall && wall.dist > tMin) bestT = wall.dist;
    for (const e of this.entities.values()) {
      if (e.gone || !e.cur || e.role !== C.ROLE_HIDER || !e.group.visible) continue;
      const t = rayHitsBody(o, d, e.cur.x * U, e.cur.y * U, e.pose, e.cur.yaw);
      if (t !== null && t > tMin && t < bestT) bestT = t;
    }
    const px = o.x + d.x * bestT - eye.x, py = o.y + d.y * bestT - eye.y, ph = o.h + d.h * bestT - eye.h;
    const flat = Math.hypot(px, py);
    if (flat + Math.abs(ph) < 0.4) {
      return { yaw: Math.atan2(d.y, d.x), pitch: Math.atan2(d.h, Math.hypot(d.x, d.y)) };
    }
    return { yaw: Math.atan2(py, px), pitch: Math.atan2(ph, flat) };
  }

  /** Schuss des Farbmarkierers: Leuchtspur von der Muendung, Muendungsblitz und Einschlag. */
  shot(ev) {
    const b = new THREE.Vector3(ev.to.x, ev.to.h, ev.to.y);
    // Start an der Muendung der Waffe, wenn die Figur sichtbar ist - sonst Augenhoehe.
    const shooter = ev.id === this.meId ? this.me : this.entities.get(ev.id)?.group;
    const a = new THREE.Vector3(ev.from.x, ev.from.h, ev.from.y);
    const muzzle = shooter?.visible ? shooter.userData.muzzle : null;
    if (muzzle) { shooter.updateMatrixWorld(true); muzzle.getWorldPosition(a); }
    const len = a.distanceTo(b);
    if (len > 0.05) {
      // Leuchtender Strahl als duenner Zylinder (Linien sind in WebGL nur 1 Pixel breit).
      const color = ev.hit ? 0xff3d6e : 0xffa24a;
      const beam = new THREE.Mesh(GEO.beam, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
      beam.position.copy(a).lerp(b, 0.5);
      beam.scale.set(1, len, 1);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      beam.userData.life = 0.22; beam.userData.max = 0.22;
      this.scene.add(beam);
      this.tracers.push(beam);
      const flash = new THREE.Mesh(GEO.flash, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
      flash.position.copy(a);
      flash.userData.life = 0.08; flash.userData.max = 0.08;
      this.scene.add(flash);
      this.tracers.push(flash);
    }
    if (ev.wall) {
      // Farbfleck an der Wand/am Boden, ausgerichtet an der Flaechennormalen.
      const n = new THREE.Vector3(ev.wall.nx, ev.wall.nh, ev.wall.ny);
      if (n.lengthSq() < 0.5) n.set(0, 1, 0);
      const d = new THREE.Mesh(GEO.decal, new THREE.MeshBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      d.position.copy(b).addScaledVector(n, 0.01);
      d.lookAt(b.clone().add(n));
      d.scale.setScalar(0.8 + Math.random() * 0.6);
      d.rotation.z = Math.random() * Math.PI;
      this.scene.add(d);
      this.decals.push(d);
      if (this.decals.length > 80) { const old = this.decals.shift(); this.scene.remove(old); old.material.dispose(); }
    } else if (ev.hit) {
      this.burst(ev.to.x * C.TILE, ev.to.y * C.TILE, 0xff8c42, 18, 3, ev.to.h);
    }
  }

  // ---------------------------------------------------------------- Frame
  /**
   * @param {object} f {dt, now, me:{x,y,yaw,pitch,role,alive,pose,stun,speed,painting}, meId, paintMode}
   */
  update(f) {
    const dt = Math.min(f.dt, 0.05);
    this.clock += dt;
    const renderT = f.now - C.INTERP_DELAY_MS;
    this.paintMode = !!f.paintMode;
    this.meId = f.meId;

    if (f.me) {
      this.ensureMe(f.me.role);
      const g = this.me;
      g.position.set(f.me.x * U, 0, f.me.y * U);
      // In einer Pose bleibt der Koerper liegen, wie er abgelegt wurde; die Kamera dreht frei.
      const targetRot = -(f.me.bodyYaw ?? f.me.yaw);
      g.rotation.y += angleDiff(g.rotation.y, targetRot) * Math.min(1, dt * 16);
      animateHumanoid(g, f.me.speed ?? 0, dt, f.me.pose, f.me.stun > 0, f.me.pitch);
      g.visible = f.me.alive;
      g.userData.ring.material.opacity = 0.7;
      g.userData.ring.material.color.set(f.me.role === C.ROLE_SEEKER ? 0xff8c42 : 0x7ee787);
      this.updateCamera(f, dt);
    } else {
      // Lobby/Menue: langsame Rundfahrt ueber die Karte
      const t = this.clock * 0.08;
      const cx = (this.map?.w ?? 60) / 2, cz = (this.map?.h ?? 40) / 2;
      this.camera.position.set(cx + Math.cos(t) * 18, 12, cz + Math.sin(t) * 18);
      this.camera.lookAt(cx, 0, cz);
    }

    for (const e of this.entities.values()) {
      const pos = this.sample(e.buf, renderT);
      if (pos) {
        if (!e.cur) e.cur = { x: pos.x, y: pos.y, yaw: pos.yaw, pitch: pos.pitch };
        const speed = Math.hypot(pos.x - e.cur.x, pos.y - e.cur.y) / Math.max(dt, 1e-3);
        e.cur.x = pos.x; e.cur.y = pos.y;
        e.cur.yaw += angleDiff(e.cur.yaw, pos.yaw) * Math.min(1, dt * 12);
        e.cur.pitch = pos.pitch;
        e.group.position.set(pos.x * U, 0, pos.y * U);
        e.group.rotation.y = -e.cur.yaw;
        e.speedEst = lerp(e.speedEst ?? 0, Math.min(speed, 400), 0.3);
      }
      if (e.gone && f.now - e.lastSeen > 600) { this.removeEntity(e.id); continue; }
      e.group.visible = !e.gone;
      animateHumanoid(e.group, e.speedEst ?? 0, dt, e.pose, e.stun > 0, e.cur?.pitch ?? 0);
      const friendly = f.me && (e.role === C.ROLE_SEEKER ? f.me.role === C.ROLE_SEEKER : f.me.role === C.ROLE_HIDER);
      e.group.userData.ring.material.opacity = friendly ? 0.4 : 0;
      e.group.userData.ring.material.color.set(e.role === C.ROLE_SEEKER ? 0xff8c42 : 0x7ee787);
      this.updateLabel(e, f);
    }

    const cx = this.camera.position.x, cz = this.camera.position.z;
    this.sun.position.set(cx + 14, 16, cz + 9);
    this.sun.target.position.set(cx, 0, cz);
    this.fill.position.set(cx - 10, 8, cz - 12);
    this.fill.target.position.set(cx, 0, cz);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.userData.life -= dt;
      t.material.opacity = Math.max(0, t.userData.life / (t.userData.max ?? 0.14));
      if (t.userData.max) t.scale.x = t.scale.z = 0.4 + 0.6 * Math.max(0, t.userData.life / t.userData.max);
      if (t.userData.life <= 0) { this.scene.remove(t); t.material.dispose(); this.tracers.splice(i, 1); }   // Geometrie ist geteilt
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const m = this.particles[i], u = m.userData;
      u.life -= dt;
      u.vy -= 9 * dt;
      m.position.x += u.vx * dt; m.position.y += u.vy * dt; m.position.z += u.vz * dt;
      if (m.position.y < 0.04) { m.position.y = 0.04; u.vy *= -0.3; u.vx *= 0.7; u.vz *= 0.7; }
      m.material.opacity = Math.max(0, u.life / u.max);
      if (u.life <= 0) { this.scene.remove(m); this.particles.splice(i, 1); this.particlePool.push(m); }
    }

    if (this.world) animateWorld(this.world, this.clock);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Third-Person-Kamera: hinter der Figur, leicht ueber der Schulter.
   * - Schulterversatz nur so weit, wie seitlich Platz ist (sonst landet der Drehpunkt in der Mauer).
   * - Nie hoeher als knapp unter die Innenmauern: kein Blick ueber Mauern in den Nachbargang.
   * - Steht eine Mauer im Weg, sitzt die Kamera immer DAVOR; heran sofort, zurueck weich.
   * - Ist die Kamera sehr nah am Kopf, wird die eigene Figur ausgeblendet.
   * Das Fadenkreuz bleibt stimmig, weil aimFrom() mit der echten Kamerarichtung rechnet.
   */
  updateCamera(f, dt) {
    const me = f.me;
    const pivotH = this.paintMode ? 0.95 : 1.35;
    let yaw, pitch, dist, side;
    if (this.paintMode) { yaw = this.orbit.yaw; pitch = this.orbit.pitch; dist = this.orbit.dist; side = 0; }
    else { yaw = me.yaw; pitch = me.pitch; dist = 3.1; side = 0.45; }
    const cx = me.x * U, cz = me.y * U;
    const rx = -Math.sin(yaw), rz = Math.cos(yaw);     // rechts
    if (side > 0 && this.map) {
      const sh = raycast3D(this.map, { x: cx, y: cz, h: pivotH }, { x: rx, y: rz, h: 0 }, side + 0.25);
      if (sh) side = Math.max(0, sh.dist - 0.25);
    }
    const pivot = new THREE.Vector3(cx + rx * side, pivotH, cz + rz * side);
    const d = dirFromAngles(yaw, pitch);
    // Wunschposition, Hoehe begrenzt (Innenmauern sind 2,4 m hoch)
    const want = new THREE.Vector3(pivot.x - d.x * dist, pivot.y - d.h * dist, pivot.z - d.y * dist);
    const capH = C.WALL_H_INNER - 0.25;
    if (want.y > capH) want.y = capH;
    if (want.y < 0.2) want.y = 0.2;
    // Mauern zwischen Drehpunkt und Kamera
    const back = want.clone().sub(pivot);
    const len = back.length();
    back.divideScalar(Math.max(len, 1e-6));
    const hit = this.map ? raycast3D(this.map, { x: pivot.x, y: pivot.z, h: pivot.y }, { x: back.x, y: back.z, h: back.y }, len + 0.25) : null;
    const target = hit ? Math.max(0.05, Math.min(len, hit.dist - 0.25)) : len;
    this.camDist = (this.camDist === undefined || target < this.camDist) ? target : this.camDist + (target - this.camDist) * Math.min(1, dt * 5);
    const pos = pivot.clone().addScaledVector(back, this.camDist);
    const k = this.paintMode ? Math.min(1, dt * 10) : 1;
    this.camPos.lerp(pos, k);
    this.camera.position.copy(this.camPos);
    const look = this.paintMode
      ? new THREE.Vector3(pivot.x, pivot.y, pivot.z)
      : new THREE.Vector3(pivot.x + d.x * 3, pivot.y + d.h * 3, pivot.z + d.y * 3);
    this.camLook.lerp(look, k);
    this.camera.lookAt(this.camLook);
    if (this.me) this.me.visible = !!me.alive && (this.paintMode || this.camDist > 0.55);
  }

  /** Malmodus: Umlaufbahn mit dem meisten freien Platz um die Figur waehlen. */
  chooseOrbit(yawHint) {
    if (!this.me || !this.map) return;
    const pivot = { x: this.me.position.x, y: this.me.position.z, h: 0.95 };
    let best = { yaw: yawHint, pitch: 0.15, free: -1 };
    for (let i = 0; i < 16; i++) {
      const yaw = yawHint + (i / 16) * Math.PI * 2;
      for (const pitch of [0.15, 0.5]) {
        const dd = dirFromAngles(yaw, pitch);
        const hit = raycast3D(this.map, pivot, { x: -dd.x, y: -dd.y, h: -dd.h }, this.orbit.dist + 0.3);
        const fr = hit ? hit.dist : this.orbit.dist + 0.3;
        // Bevorzugt die urspruengliche Richtung (i = 0) und flache Sicht
        const score = fr - i * 0.02 - (pitch > 0.3 ? 0.15 : 0);
        if (score > best.free) best = { yaw, pitch, free: score };
      }
    }
    this.orbit.yaw = best.yaw;
    this.orbit.pitch = best.pitch;
  }

  sample(buf, t) {
    if (buf.length === 0) return null;
    if (buf.length === 1 || t <= buf[0].t) return buf[0];
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i], b = buf[i + 1];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), yaw: a.yaw + angleDiff(a.yaw, b.yaw) * k, pitch: lerp(a.pitch, b.pitch, k) };
      }
    }
    const a = buf[buf.length - 2], b = buf[buf.length - 1];
    const k = Math.min(1.5, (t - b.t) / Math.max(1, b.t - a.t));
    return { x: b.x + (b.x - a.x) * k * 0.5, y: b.y + (b.y - a.y) * k * 0.5, yaw: b.yaw, pitch: b.pitch };
  }

  updateLabel(e, f) {
    const show = e.name && !e.gone && !this.paintMode;
    if (!show) { if (e.labelEl) e.labelEl.style.display = 'none'; return; }
    if (!e.labelEl) { e.labelEl = document.createElement('div'); this.labelsEl.appendChild(e.labelEl); }
    const cls = e.decoy ? 'decoy' : e.role === C.ROLE_SEEKER ? 'seeker' : '';
    e.labelEl.className = `label ${cls}`;
    e.labelEl.textContent = e.decoy ? `Köder ${e.life ?? ''}s` : e.name;
    const v = new THREE.Vector3(e.group.position.x, C.POSES[e.pose]?.h + 0.25 || 2, e.group.position.z).project(this.camera);
    if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) { e.labelEl.style.display = 'none'; return; }
    e.labelEl.style.display = '';
    e.labelEl.style.left = `${(v.x + 1) / 2 * window.innerWidth}px`;
    e.labelEl.style.top = `${(1 - v.y) / 2 * window.innerHeight}px`;
  }

  clearAll() {
    for (const id of [...this.entities.keys()]) this.removeEntity(id);
    for (const [k, m] of this.splats) { this.scene.remove(m); m.material.dispose(); this.splats.delete(k); }
    for (const d of this.decals) { this.scene.remove(d); d.material.dispose(); }
    this.decals = [];
    this.pendingPaint.clear();
  }
}
