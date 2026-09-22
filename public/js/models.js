// Prozedurale Figuren. Einheit: 1 = eine Kachel = ein Meter. Figuren schauen entlang +X.
//
// Das Mannequin besteht aus Quadern, die alle EINE Textur teilen (Atlas).
// Jede Quaderflaeche bekommt ein eigenes Feld im Atlas, damit Vorder- und
// Rueckseite unabhaengig bemalt werden koennen - so wie man sich im Vorbild
// mit dem Pinsel Stueck fuer Stueck anmalt.

import * as THREE from 'three';
import { PAINT_TEX, POSES } from '/shared/constants.js';

export function rgb(c) {
  return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}

// ---------------------------------------------------------------- Atlas
// Koerperteile und ihre Felder im Atlas (Spalte, Zeile) auf einem 4x4-Raster.
// Jedes Teil bekommt ein Feld; die 6 Quaderflaechen werden darin als 3x2-Raster verteilt.
export const PARTS = [
  { key: 'head',   size: [0.24, 0.26, 0.24], cell: [0, 0], pivot: [0, 1.42, 0], offset: [0, 0.13, 0] },
  { key: 'torso',  size: [0.24, 0.55, 0.42], cell: [1, 0], pivot: [0, 0.85, 0], offset: [0, 0.28, 0] },
  { key: 'hips',   size: [0.24, 0.16, 0.38], cell: [2, 0], pivot: [0, 0.85, 0], offset: [0, -0.08, 0] },
  { key: 'armUL',  size: [0.12, 0.30, 0.12], cell: [3, 0], pivot: [0, 1.36, 0.28], offset: [0, -0.15, 0] },
  { key: 'armUR',  size: [0.12, 0.30, 0.12], cell: [0, 1], pivot: [0, 1.36, -0.28], offset: [0, -0.15, 0] },
  { key: 'armLL',  size: [0.11, 0.30, 0.11], cell: [1, 1], pivot: [0, -0.30, 0], offset: [0, -0.15, 0], parent: 'armUL' },
  { key: 'armLR',  size: [0.11, 0.30, 0.11], cell: [2, 1], pivot: [0, -0.30, 0], offset: [0, -0.15, 0], parent: 'armUR' },
  { key: 'legUL',  size: [0.15, 0.40, 0.15], cell: [3, 1], pivot: [0, 0.78, 0.11], offset: [0, -0.20, 0] },
  { key: 'legUR',  size: [0.15, 0.40, 0.15], cell: [0, 2], pivot: [0, 0.78, -0.11], offset: [0, -0.20, 0] },
  { key: 'legLL',  size: [0.13, 0.38, 0.13], cell: [1, 2], pivot: [0, -0.40, 0], offset: [0, -0.19, 0], parent: 'legUL' },
  { key: 'legLR',  size: [0.13, 0.38, 0.13], cell: [2, 2], pivot: [0, -0.40, 0], offset: [0, -0.19, 0], parent: 'legUR' },
];
const GRID = 4;

/** Quader mit UVs, die in das Atlasfeld (cx,cy) fallen; je Flaeche ein 3x2-Unterfeld. */
function partGeometry(size, cell) {
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const uv = geo.attributes.uv;
  const u0 = cell[0] / GRID, v0 = 1 - (cell[1] + 1) / GRID;   // Atlasfeld (v von unten)
  const cw = 1 / GRID, ch = 1 / GRID;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);                 // 0..5: +x -x +y -y +z -z
    const fx = face % 3, fy = Math.floor(face / 3); // 3x2-Raster im Feld
    const u = uv.getX(i), v = uv.getY(i);
    const pad = 0.02;                                // kleiner Rand gegen Kantenbluten
    const uu = u0 + (fx + pad + u * (1 - 2 * pad)) * (cw / 3);
    const vv = v0 + (fy + pad + v * (1 - 2 * pad)) * (ch / 2);
    uv.setXY(i, uu, vv);
  }
  return geo;
}

/** Leere (weisse) Koerpertextur als Canvas. */
export function makePaintCanvas(fill = '#f2f2f0') {
  const cv = document.createElement('canvas');
  cv.width = PAINT_TEX; cv.height = PAINT_TEX;
  // Der Kontext wird haeufig gelesen (Rueckgaengig, Durchschnittsfarbe) - das sagt man dem Browser besser vorher.
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, PAINT_TEX, PAINT_TEX);
  return cv;
}

export function makePaintTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Mannequin. Rueckgabe: Group mit userData {parts: {key: Mesh}, canvas, texture, material, kind}.
 * Fuer Jaeger wird eine dunkle Montur mit Visier erzeugt (nicht bemalbar).
 */
export function makeHumanoid(kind = 'hider') {
  const g = new THREE.Group();
  const canvas = makePaintCanvas(kind === 'seeker' ? '#4a4f5c' : '#f2f2f0');
  const texture = makePaintTexture(canvas);
  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: kind === 'seeker' ? 0.55 : 0.85, metalness: kind === 'seeker' ? 0.15 : 0.0,
  });
  const parts = {};
  const joints = {};
  for (const p of PARTS) {
    const joint = new THREE.Group();
    joint.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
    const mesh = new THREE.Mesh(partGeometry(p.size, p.cell), material);
    mesh.position.set(p.offset[0], p.offset[1], p.offset[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.part = p.key;
    joint.add(mesh);
    parts[p.key] = mesh;
    joints[p.key] = joint;
    (p.parent ? joints[p.parent] : g).add(joint);
  }
  // Der Rumpf haengt an der Huefte, damit Beugen den Oberkoerper mitnimmt.
  // (Kopf und Arme sind direkt an der Gruppe verankert und werden ueber die Pose mitgefuehrt.)

  if (kind === 'seeker') {
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.07, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xff8c42, emissive: 0xff8c42, emissiveIntensity: 1.2, roughness: 0.3 }),
    );
    visor.position.set(0.13, 0.15, 0);
    joints.head.add(visor);
    // Farbmarkierer in der rechten Hand
    const gun = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.07), new THREE.MeshStandardMaterial({ color: 0x1c1e26, metalness: 0.5, roughness: 0.4 }));
    body.position.set(0.14, -0.3, 0);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.4 }));
    tank.rotation.z = Math.PI / 2; tank.position.set(0.02, -0.24, 0);
    gun.add(body); gun.add(tank);
    joints.armLR.add(gun);
    g.userData.gun = gun;
  }

  // Bodenring: Team-Kennzeichnung (nur fuer Mitspieler derselben Seite sichtbar).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 28),
    new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  ring.userData.hud = true;
  g.add(ring);

  g.userData = { parts, joints, canvas, texture, material, ring, kind, phase: Math.random() * 6, poseT: 0, pose: 0, gun: g.userData.gun };
  return g;
}

// ---------------------------------------------------------------- Posen
// Gelenkwinkel (Radiant) je Pose. x = seitliches Heben, z = Beugen vor/zurueck.
// rootY = Hoehe der Huefte ueber dem Boden, rootRot = Neigung des ganzen Koerpers.
const P = {
  stand:  { rootY: 0, rootRotZ: 0, head: [0, 0, 0], torso: [0, 0, 0], armUL: [0, 0, 0.08], armUR: [0, 0, -0.08], armLL: [0, 0, 0], armLR: [0, 0, 0], legUL: [0, 0, 0], legUR: [0, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  crouch: { rootY: -0.62, rootRotZ: 0.35, head: [0, 0, -0.3], torso: [0, 0, 0], armUL: [0, 0, -0.6], armUR: [0, 0, -0.6], armLL: [0, 0, -1.4], armLR: [0, 0, -1.4], legUL: [0, 0, -2.0], legUR: [0, 0, -2.0], legLL: [0, 0, 2.4], legLR: [0, 0, 2.4] },
  sit:    { rootY: -0.72, rootRotZ: 0, head: [0, 0, 0], torso: [0, 0, 0], armUL: [0, 0, -0.9], armUR: [0, 0, -0.9], armLL: [0, 0, -0.9], armLR: [0, 0, -0.9], legUL: [0, 0, -1.5708], legUR: [0, 0, -1.5708], legLL: [0, 0, 1.5708], legLR: [0, 0, 1.5708] },
  lie:    { rootY: -0.70, rootRotZ: -1.5708, head: [0, 0, 0.3], torso: [0, 0, 0], armUL: [0, 0, 0.1], armUR: [0, 0, -0.1], armLL: [0, 0, 0], armLR: [0, 0, 0], legUL: [0, 0, 0], legUR: [0, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  press:  { rootY: 0, rootRotZ: 0, head: [0, 0.6, 0], torso: [0, 0, 0], armUL: [2.6, 0, 0], armUR: [-2.6, 0, 0], armLL: [0.3, 0, 0], armLR: [-0.3, 0, 0], legUL: [0.15, 0, 0], legUR: [-0.15, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  ball:   { rootY: -0.78, rootRotZ: 0.9, head: [0, 0, -1.0], torso: [0, 0, 0], armUL: [0, 0, -1.6], armUR: [0, 0, -1.6], armLL: [0, 0, -1.8], armLR: [0, 0, -1.8], legUL: [0, 0, -2.4], legUR: [0, 0, -2.4], legLL: [0, 0, 2.6], legLR: [0, 0, 2.6] },
};
export const POSE_DEFS = POSES.map((p) => P[p.id]);

/**
 * Bewegt die Figur: Gehanimation bei Tempo, sonst weich in die Pose.
 * @param {THREE.Group} g   Figur
 * @param {number} speed    px/s in der Bodenebene
 * @param {number} dt
 * @param {number} pose     Index
 * @param {boolean} stunned
 * @param {number} pitch    Blick-Nicken (Kopf folgt leicht)
 */
export function animateHumanoid(g, speed, dt, pose = 0, stunned = false, pitch = 0) {
  const ud = g.userData;
  const j = ud.joints;
  ud.phase += dt * (1.5 + speed * 0.05);
  const moving = speed > 8;
  const def = moving ? P.stand : (POSE_DEFS[pose] ?? P.stand);
  const k = Math.min(1, dt * 9);
  const sw = Math.min(1, speed / 150);

  const target = (key, axis) => {
    const base = def[key]?.[axis] ?? 0;
    if (!moving) return base;
    // Gehen: Arme und Beine gegenlaeufig schwingen
    const s = Math.sin(ud.phase * 2.2) * 0.7 * sw;
    if (axis !== 2) return base;
    if (key === 'legUL') return s; if (key === 'legUR') return -s;
    if (key === 'legLL') return Math.max(0, -s) * 1.1; if (key === 'legLR') return Math.max(0, s) * 1.1;
    if (key === 'armUL') return -s * 0.8; if (key === 'armUR') return s * 0.8;
    if (key === 'armLL' || key === 'armLR') return -0.35;
    return base;
  };
  for (const key of Object.keys(j)) {
    const r = j[key].rotation;
    r.x += (target(key, 0) - r.x) * k;
    r.y += (target(key, 1) - r.y) * k;
    r.z += (target(key, 2) - r.z) * k;
  }
  // Kopf nickt leicht mit dem Blick
  j.head.rotation.z += ((-pitch * 0.5) - j.head.rotation.z) * k * 0.5;
  // Gesamtkoerper: Hoehe und Neigung der Pose, Wippen beim Gehen, Wackeln bei Betaeubung
  const bob = moving ? Math.abs(Math.sin(ud.phase * 2.2)) * 0.035 * sw : 0;
  const rootY = (def.rootY ?? 0) + bob;
  const rootRotZ = def.rootRotZ ?? 0;
  const body = ud.body;
  body.position.y += (rootY - body.position.y) * k;
  body.rotation.z += (rootRotZ - body.rotation.z) * k;
  g.rotation.z = stunned ? Math.sin(ud.phase * 6) * 0.12 : 0;
}

/**
 * Hilfsobjekt fuer die Figurenerstellung: Alle Gelenke haengen an einer
 * "body"-Gruppe, damit Posen den ganzen Koerper heben/neigen koennen.
 */
export function makeFigure(kind) {
  const outer = new THREE.Group();
  const g = makeHumanoid(kind);
  // Ring bleibt aussen (unbeeinflusst von Pose)
  const ring = g.userData.ring;
  g.remove(ring);
  outer.add(ring);
  outer.add(g);
  outer.userData = { ...g.userData, body: g, ring };
  return outer;
}

// ---------------------------------------------------------------- Saeule
export function makePillar() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x3a4050, roughness: 0.85 });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 2.5, 10), stone);
  col.position.y = 1.25;
  col.castShadow = true; col.receiveShadow = true;
  g.add(col);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.38, 0.2, 10), stone);
  cap.position.y = 2.55;
  cap.castShadow = true;
  g.add(cap);
  g.userData = { color: [58, 64, 80] };
  return g;
}

export const GEO = {
  wall: new THREE.BoxGeometry(1, 1, 1),
  bush: new THREE.IcosahedronGeometry(0.52, 1),
  water: new THREE.PlaneGeometry(1, 1),
  splat: new THREE.CircleGeometry(0.28, 12),
  particle: new THREE.SphereGeometry(0.05, 6, 5),
  decal: new THREE.CircleGeometry(0.16, 10),
};
