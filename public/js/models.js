// Prozedurale Figuren. Einheit: 1 = eine Kachel = ein Meter. Figuren schauen entlang +X.
//
// Das Mannequin besteht aus abgerundeten Quadern, die alle EINE Textur teilen (Atlas).
// Jede Quaderflaeche bekommt ein eigenes Feld im Atlas, damit Vorder- und
// Rueckseite unabhaengig bemalt werden koennen - so wie man sich im Vorbild
// mit dem Pinsel Stueck fuer Stueck anmalt.
//
// Gelenkkugeln (Schulter, Ellbogen, Huefte, Knie), Haende, Fuesse und Hals sind
// direkt in die Geometrie des zugehoerigen Koerperteils eingeschmolzen. Ihre UVs
// zeigen auf die angrenzende Stelle des Teils im Atlas - dadurch uebernehmen sie
// automatisch die Farbe, mit der man das Teil dort bemalt hat. Es bleibt bei
// 11 Meshes je Figur (userData.parts), das Atlas-Layout ist unveraendert.

import * as THREE from 'three';
import { PAINT_TEX, POSES, WALL_COLOR } from '/shared/constants.js';

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

// Form je Teil: Kantenradius und Verjuengung (Faktor oben/unten fuer Tiefe x und Breite z).
// Nur die Positionen werden verformt - die UVs bleiben flaechentreu, Bemalen funktioniert wie zuvor.
const SHAPE = {
  head:  { r: 0.095, x: [1.0, 0.9], z: [0.96, 0.84] },
  torso: { r: 0.085, x: [1.0, 0.86], z: [1.0, 0.82] },
  hips:  { r: 0.07, x: [0.92, 1.0], z: [0.9, 1.0] },
  armU:  { r: 0.056, x: [1.0, 0.88], z: [1.0, 0.88] },
  armL:  { r: 0.05, x: [0.96, 0.8], z: [0.96, 0.8] },
  legU:  { r: 0.07, x: [1.0, 0.84], z: [1.0, 0.84] },
  legL:  { r: 0.062, x: [0.98, 0.76], z: [0.98, 0.76] },
};
const shapeOf = (key) => SHAPE[key] ?? SHAPE[key.slice(0, 4)];

// Anbauten je Teil (in Mesh-Koordinaten des Teils). sampleY: Hoehe, an der die
// Farbe fuer den Anbau aus dem Teil abgelesen wird.
const ADDONS = {
  head:  [{ kind: 'sphere', pos: [-0.005, -0.15, 0], r: [0.062, 0.075, 0.062], sampleY: -0.09 }],
  armU:  [{ kind: 'sphere', pos: [0, 0.14, 0], r: [0.079, 0.079, 0.079], sampleY: 0.1 }],
  armL:  [{ kind: 'sphere', pos: [0, 0.15, 0], r: [0.062, 0.062, 0.062], sampleY: 0.1 },
          { kind: 'sphere', pos: [0.005, -0.2, 0], r: [0.05, 0.075, 0.034], sampleY: -0.11 }],
  legU:  [{ kind: 'sphere', pos: [0, 0.19, 0], r: [0.086, 0.086, 0.086], sampleY: 0.15 }],
  legL:  [{ kind: 'sphere', pos: [0, 0.19, 0], r: [0.073, 0.073, 0.073], sampleY: 0.14 },
          { kind: 'foot', pos: [0.05, -0.1525, 0], size: [0.25, 0.075, 0.115], sampleY: -0.14 }],
};
const addonsOf = (key) => ADDONS[key] ?? ADDONS[key.slice(0, 4)] ?? [];

const SEG = 5;   // ungerade: das mittlere Segment bleibt flach, die aeusseren bilden die Rundung

/**
 * Abgerundeter Quader (wie RoundedBoxGeometry), UVs je Flaeche 0..1 nach Bogenlaenge.
 * Vertex- und Flaechenreihenfolge (+x -x +y -y +z -z) wie bei BoxGeometry.
 */
function roundedBox(w, h, d, radius) {
  const geo = new THREE.BoxGeometry(1, 1, 1, SEG, SEG, SEG);
  const r = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const box = { x: w / 2 - r, y: h / 2 - r, z: d / 2 - r };
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  const half = 0.5 / SEG;
  const n = new THREE.Vector3();
  const perFace = (SEG + 1) * (SEG + 1);
  // Abgerollte Flaechenlaenge je Achse: flacher Teil + zwei Achtelboegen
  const L = { x: 2 * box.x + r * Math.PI / 2, y: 2 * box.y + r * Math.PI / 2, z: 2 * box.z + r * Math.PI / 2 };
  const AX = [['z', 'y'], ['z', 'y'], ['x', 'z'], ['x', 'z'], ['x', 'y'], ['x', 'y']];   // (u, v) je Flaeche
  const unroll = (axis) => (box[axis] + r * Math.asin(Math.min(1, Math.abs(n[axis])))) / L[axis];
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    n.set(px - Math.sign(px) * half, py - Math.sign(py) * half, pz - Math.sign(pz) * half).normalize();
    pos.setXYZ(i, box.x * Math.sign(px) + n.x * r, box.y * Math.sign(py) + n.y * r, box.z * Math.sign(pz) + n.z * r);
    nor.setXYZ(i, n.x, n.y, n.z);
    const [au, av] = AX[Math.floor(i / perFace)];
    const u0 = uv.getX(i), v0 = uv.getY(i);
    uv.setXY(i, 0.5 + Math.sign(u0 - 0.5) * unroll(au), 0.5 + Math.sign(v0 - 0.5) * unroll(av));
  }
  return geo;
}

/** Legt die Flaechen-UVs (0..1) in das Atlasfeld (cx,cy); je Flaeche ein 3x2-Unterfeld. */
function atlasRemap(geo, cell) {
  const uv = geo.attributes.uv;
  const u0 = cell[0] / GRID, v0 = 1 - (cell[1] + 1) / GRID;   // Atlasfeld (v von unten)
  const cw = 1 / GRID, ch = 1 / GRID;
  const perFace = uv.count / 6;
  const pad = 0.02;                                  // kleiner Rand gegen Kantenbluten
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / perFace);           // 0..5: +x -x +y -y +z -z
    const fx = face % 3, fy = Math.floor(face / 3); // 3x2-Raster im Feld
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, u0 + (fx + pad + u * (1 - 2 * pad)) * (cw / 3), v0 + (fy + pad + v * (1 - 2 * pad)) * (ch / 2));
  }
}

/** Verjuengt ein Teil entlang y (Faktoren oben/unten fuer x und z). */
function taper(geo, h, shape) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(pos.getY(i) / h + 0.5, 0, 1);   // 0 unten, 1 oben
    pos.setX(i, pos.getX(i) * (shape.x[1] + (shape.x[0] - shape.x[1]) * t));
    pos.setZ(i, pos.getZ(i) * (shape.z[1] + (shape.z[0] - shape.z[1]) * t));
  }
}

/** Indizierte Geometrien (position/normal/uv) zu einer zusammenfuegen. */
function merge(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const total = list.reduce((s, g) => s + g.attributes[name].array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, list[0].attributes[name].itemSize));
  }
  const idx = [];
  let base = 0;
  for (const g of list) {
    const gi = g.index ? g.index.array : [...Array(g.attributes.position.count).keys()];
    for (let i = 0; i < gi.length; i++) idx.push(gi[i] + base);
    base += g.attributes.position.count;
  }
  out.setIndex(idx);
  return out;
}

const _ray = new THREE.Raycaster();
const _pickMat = new THREE.MeshBasicMaterial();

/**
 * Anbau (Gelenkkugel, Hand, Fuss): jeder Vertex bekommt die UV der Teiloberflaeche,
 * die in seiner waagerechten Richtung auf Hoehe sampleY liegt.
 */
function addonGeometry(spec, partGeo) {
  let geo;
  if (spec.kind === 'foot') {
    geo = roundedBox(spec.size[0], spec.size[1], spec.size[2], 0.034);
  } else {
    geo = new THREE.SphereGeometry(1, 14, 10);
    geo.scale(spec.r[0], spec.r[1], spec.r[2]);
    geo.computeVertexNormals();
  }
  geo.translate(spec.pos[0], spec.pos[1], spec.pos[2]);
  const probe = new THREE.Mesh(partGeo, _pickMat);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const dir = new THREE.Vector3(), org = new THREE.Vector3(), back = new THREE.Vector3();
  const cache = new Map();
  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i) - spec.pos[0], 0, pos.getZ(i) - spec.pos[2]);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const key = `${dir.x.toFixed(3)},${dir.z.toFixed(3)}`;
    let hitUv = cache.get(key);
    if (!hitUv) {
      org.set(0, spec.sampleY, 0).addScaledVector(dir, 1);
      _ray.set(org, back.copy(dir).negate());
      const hit = _ray.intersectObject(probe, false)[0];
      hitUv = hit?.uv ? hit.uv.clone() : null;
      if (!hitUv) hitUv = nearestUv(partGeo, org.set(0, spec.sampleY, 0).addScaledVector(dir, 0.05));
      cache.set(key, hitUv);
    }
    uv.setXY(i, hitUv.x, hitUv.y);
  }
  return geo;
}

/** Rueckfall fuer addonGeometry: UV des naechstgelegenen Vertex. */
function nearestUv(geo, p) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const d = (pos.getX(i) - p.x) ** 2 + (pos.getY(i) - p.y) ** 2 + (pos.getZ(i) - p.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return new THREE.Vector2(uv.getX(best), uv.getY(best));
}

const partCache = new Map();

/** Fertige Teilgeometrie (abgerundet, verjuengt, mit Anbauten, Atlas-UVs). Wird je Figur geklont. */
function partGeometry(p) {
  let geo = partCache.get(p.key);
  if (!geo) {
    const shape = shapeOf(p.key);
    const bodyGeo = roundedBox(p.size[0], p.size[1], p.size[2], shape.r);
    taper(bodyGeo, p.size[1], shape);
    atlasRemap(bodyGeo, p.cell);
    geo = merge([bodyGeo, ...addonsOf(p.key).map((spec) => addonGeometry(spec, bodyGeo))]);
    geo.computeBoundingSphere();
    partCache.set(p.key, geo);
  }
  return geo.clone();
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

// ---------------------------------------------------------------- Sucher-Ausruestung
const SEEKER_MAT = {
  dark: new THREE.MeshStandardMaterial({ color: 0x1c1f28, metalness: 0.55, roughness: 0.38 }),
  orange: new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.42, metalness: 0.1 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffb070, emissive: 0xff8c42, emissiveIntensity: 1.6, roughness: 0.25, side: THREE.DoubleSide }),
};

/** Farbmarkierer: Lauf zeigt entlang +x. Liefert Gruppe und Muendungspunkt. */
function makeMarker() {
  const gun = new THREE.Group();
  const add = (geo, mat, x, y, z, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.z = rz;
    m.castShadow = true;
    gun.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.3, 0.075, 0.065), SEEKER_MAT.dark, 0.08, 0, 0);                              // Gehaeuse
  add(new THREE.CylinderGeometry(0.022, 0.026, 0.2, 10), SEEKER_MAT.dark, 0.3, 0.012, 0, Math.PI / 2);      // Lauf
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10), SEEKER_MAT.orange, 0.39, 0.012, 0, Math.PI / 2);   // Muendungsring
  add(new THREE.CylinderGeometry(0.045, 0.045, 0.15, 12), SEEKER_MAT.orange, 0.06, 0.075, 0, Math.PI / 2); // Farbtank
  add(new THREE.BoxGeometry(0.05, 0.11, 0.05), SEEKER_MAT.dark, -0.02, -0.07, 0, -0.25);                   // Griff
  add(new THREE.BoxGeometry(0.04, 0.012, 0.068), SEEKER_MAT.glow, 0.16, 0.042, 0);                         // Leuchtstreifen
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.41, 0.012, 0);
  gun.add(muzzle);
  return { gun, muzzle };
}

/**
 * Mannequin. Rueckgabe: Group mit userData {parts: {key: Mesh}, joints, canvas, texture, material, kind, gun, muzzle}.
 * Fuer Jaeger wird eine dunkle Montur mit Visier erzeugt (nicht bemalbar).
 */
export function makeHumanoid(kind = 'hider') {
  const g = new THREE.Group();
  const seeker = kind === 'seeker';
  const canvas = makePaintCanvas(seeker ? '#5a6070' : '#f2f2f0');
  const texture = makePaintTexture(canvas);
  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: seeker ? 0.5 : 0.78, metalness: seeker ? 0.18 : 0.0,
  });
  const parts = {};
  const joints = {};
  for (const p of PARTS) {
    const joint = new THREE.Group();
    joint.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
    const mesh = new THREE.Mesh(partGeometry(p), material);
    mesh.position.set(p.offset[0], p.offset[1], p.offset[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.part = p.key;
    joint.add(mesh);
    parts[p.key] = mesh;
    joints[p.key] = joint;
    (p.parent ? joints[p.parent] : g).add(joint);
  }
  // Kopf und Arme sind direkt an der Gruppe verankert und werden ueber die Pose mitgefuehrt.

  let gun = null, muzzle = null;
  if (seeker) {
    // Umlaufendes Leuchtvisier vorn am Kopf
    const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.121, 0.112, 0.07, 20, 1, true, Math.PI / 2 - 1.2, 2.4), SEEKER_MAT.glow);
    visor.position.set(0.01, 0.155, 0);
    joints.head.add(visor);
    // Helmkamm
    const crest = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.05), SEEKER_MAT.orange);
    crest.position.set(-0.01, 0.262, 0);
    crest.castShadow = true;
    joints.head.add(crest);
    // Farbtank auf dem Ruecken
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.2, 4, 12), SEEKER_MAT.orange);
    tank.position.set(-0.17, 0.3, 0);
    tank.castShadow = true;
    joints.torso.add(tank);
    // Farbmarkierer in der Hand auf der Kameraseite (+z = rechts im Bild)
    ({ gun, muzzle } = makeMarker());
    gun.position.set(0.0, -0.33, 0.0);
    gun.scale.setScalar(1.25);
    joints.armLL.add(gun);
  }

  // Bodenring: Team-Kennzeichnung (nur fuer Mitspieler derselben Seite sichtbar).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 36),
    new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  ring.userData.hud = true;
  g.add(ring);

  g.userData = { parts, joints, canvas, texture, material, ring, kind, phase: Math.random() * 6, poseT: 0, pose: 0, gun, muzzle };
  return g;
}

// ---------------------------------------------------------------- Posen
// Gelenkwinkel (Radiant) je Pose. x = seitliches Heben, z = Beugen vor/zurueck.
// rootY = Hoehe der Huefte ueber dem Boden, rootRot = Neigung des ganzen Koerpers.
// Hinweis: Die z-Winkel dieser Tabelle und des Gehzyklus sind fuer eine nach -X
// blickende Figur notiert; animateHumanoid spiegelt sie (MIRROR), damit Knie,
// Sitzen und Hocken zur Blickrichtung +X passen.
const P = {
  stand:  { rootY: 0, rootRotZ: 0, head: [0, 0, 0], torso: [0, 0, 0], armUL: [0, 0, 0.08], armUR: [0, 0, -0.08], armLL: [0, 0, 0], armLR: [0, 0, 0], legUL: [0, 0, 0], legUR: [0, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  crouch: { rootY: -0.62, rootRotZ: 0.35, head: [0, 0, -0.3], torso: [0, 0, 0], armUL: [0, 0, -0.6], armUR: [0, 0, -0.6], armLL: [0, 0, -1.4], armLR: [0, 0, -1.4], legUL: [0, 0, -2.0], legUR: [0, 0, -2.0], legLL: [0, 0, 2.4], legLR: [0, 0, 2.4] },
  sit:    { rootY: -0.72, rootRotZ: 0, head: [0, 0, 0], torso: [0, 0, 0], armUL: [0, 0, -0.9], armUR: [0, 0, -0.9], armLL: [0, 0, -0.9], armLR: [0, 0, -0.9], legUL: [0, 0, -1.5708], legUR: [0, 0, -1.5708], legLL: [0, 0, 1.5708], legLR: [0, 0, 1.5708] },
  // Liegen: auf dem Ruecken, flach am Boden und mittig ueber dem Standpunkt (rootX)
  lie:    { rootY: 0.12, rootX: 0.84, rootRotZ: -1.5708, head: [0, 0, 0.3], torso: [0, 0, 0], armUL: [0, 0, 0.1], armUR: [0, 0, -0.1], armLL: [0, 0, 0], armLR: [0, 0, 0], legUL: [0, 0, 0], legUR: [0, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  press:  { rootY: 0, rootRotZ: 0, head: [0, 0.6, 0], torso: [0, 0, 0], armUL: [2.6, 0, 0], armUR: [-2.6, 0, 0], armLL: [0.3, 0, 0], armLR: [-0.3, 0, 0], legUL: [0.15, 0, 0], legUR: [-0.15, 0, 0], legLL: [0, 0, 0], legLR: [0, 0, 0] },
  ball:   { rootY: -0.78, rootRotZ: 0.9, head: [0, 0, -1.0], torso: [0, 0, 0], armUL: [0, 0, -1.6], armUR: [0, 0, -1.6], armLL: [0, 0, -1.8], armLR: [0, 0, -1.8], legUL: [0, 0, -2.4], legUR: [0, 0, -2.4], legLL: [0, 0, 2.6], legLR: [0, 0, 2.6] },
};
export const POSE_DEFS = POSES.map((p) => P[p.id]);
const MIRROR = -1;

// Zielhaltung des Suchers (bereits fuer Blickrichtung +X notiert, wird nicht gespiegelt):
// rechter Arm (armUL/armLL, +z, Kameraseite) haelt den Markierer, linker Arm
// (armUR/armLR) stuetzt quer vor dem Koerper. Die Oberarme folgen dem Nickwinkel.
const AIM = {
  armUL: [0.1, 0.2, 1.3], armLL: [0, 0, 0.3],
  armUR: [0, -0.8, 1.0], armLR: [0, 0, 0.95],
};

/**
 * Bewegt die Figur: Gehanimation bei Tempo, sonst weich in die Pose.
 * @param {THREE.Group} g   Figur
 * @param {number} speed    px/s in der Bodenebene
 * @param {number} dt
 * @param {number} pose     Index
 * @param {boolean} stunned
 * @param {number} pitch    Blick-Nicken (positiv = nach oben; Kopf und beim Sucher der Waffenarm folgen)
 */
export function animateHumanoid(g, speed, dt, pose = 0, stunned = false, pitch = 0) {
  const ud = g.userData;
  const j = ud.joints;
  const seeker = ud.kind === 'seeker';
  ud.phase += dt * (1.5 + speed * 0.05);
  const moving = speed > 8;
  const def = moving || seeker ? P.stand : (POSE_DEFS[pose] ?? P.stand);
  const k = Math.min(1, dt * 9);
  const sw = Math.min(1, speed / 150);
  const aimPitch = THREE.MathUtils.clamp(pitch, -0.9, 0.9);

  const target = (key, axis) => {
    if (seeker && AIM[key]) {
      const a = AIM[key][axis];
      return axis === 2 && (key === 'armUL' || key === 'armUR') ? a + aimPitch : a;
    }
    const base = def[key]?.[axis] ?? 0;
    if (axis !== 2) return base;
    if (!moving) return base * MIRROR;
    // Gehen: Arme und Beine gegenlaeufig schwingen
    const s = Math.sin(ud.phase * 2.2) * 0.7 * sw;
    let v = base;
    if (key === 'legUL') v = s; else if (key === 'legUR') v = -s;
    else if (key === 'legLL') v = Math.max(0, -s) * 1.1; else if (key === 'legLR') v = Math.max(0, s) * 1.1;
    else if (key === 'armUL') v = -s * 0.8; else if (key === 'armUR') v = s * 0.8;
    else if (key === 'armLL' || key === 'armLR') v = -0.35;
    return v * MIRROR;
  };
  for (const key of Object.keys(j)) {
    const r = j[key].rotation;
    r.x += (target(key, 0) - r.x) * k;
    r.y += (target(key, 1) - r.y) * k;
    r.z += (target(key, 2) - r.z) * k;
  }
  // Kopf nickt mit dem Blick (in Posen nur angedeutet)
  const upright = moving || seeker || !pose;
  const headZ = (def.head?.[2] ?? 0) * MIRROR + aimPitch * (upright ? 0.45 : 0.15);
  j.head.rotation.z += (headZ - j.head.rotation.z) * k * 0.5;
  // Waffe zeigt unabhaengig von der Armbeugung in Blickrichtung
  if (ud.gun) ud.gun.rotation.z = aimPitch - (j.armUL.rotation.z + j.armLL.rotation.z);
  // Gesamtkoerper: Hoehe und Neigung der Pose, Wippen beim Gehen, Wackeln bei Betaeubung
  const bob = moving ? Math.abs(Math.sin(ud.phase * 2.2)) * 0.035 * sw : 0;
  const rootY = (def.rootY ?? 0) + bob;
  const rootX = (def.rootX ?? 0) * -MIRROR;
  const rootRotZ = (def.rootRotZ ?? 0) * MIRROR;
  const body = ud.body;
  body.position.y += (rootY - body.position.y) * k;
  body.position.x += (rootX - body.position.x) * k;
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
// Farbe = WALL_COLOR, genau so sieht die Server-Tarnlogik (wallColorAt) Saeulen.
export const PILLAR_COLOR = WALL_COLOR;

/** Geometrien einer Saeule (Sockel, Schaft mit Kanneluren und Entasis, Kapitell) fuer Instancing. */
export function pillarGeometries() {
  const base = new THREE.CylinderGeometry(0.44, 0.48, 0.22, 20);
  base.translate(0, 0.11, 0);
  const base2 = new THREE.CylinderGeometry(0.39, 0.42, 0.12, 20);
  base2.translate(0, 0.28, 0);
  const shaft = new THREE.CylinderGeometry(0.33, 0.37, 2.1, 32, 3, true);
  const sp = shaft.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i), z = sp.getZ(i), y = sp.getY(i);
    const a = Math.atan2(z, x);
    const f = 1 - 0.045 * Math.pow(Math.abs(Math.sin(a * 8)), 0.5);   // Kanneluren
    const bulge = 1 + 0.025 * Math.cos((y / 2.1) * Math.PI);           // Entasis
    sp.setX(i, x * f * bulge); sp.setZ(i, z * f * bulge);
  }
  shaft.computeVertexNormals();
  shaft.translate(0, 0.34 + 1.05, 0);
  const neck = new THREE.TorusGeometry(0.345, 0.03, 4, 20);
  neck.rotateX(Math.PI / 2);
  neck.translate(0, 2.4, 0);
  const cap = new THREE.CylinderGeometry(0.47, 0.35, 0.16, 20);
  cap.translate(0, 2.52, 0);
  const slab = new THREE.BoxGeometry(0.98, 0.1, 0.98);
  slab.translate(0, 2.65, 0);
  return { base: merge([base, base2]), shaft: merge([shaft, neck]), cap: merge([cap, slab]) };
}

/** Einzelne Saeule als Gruppe (Kompatibilitaet; die Arena nutzt Instancing). */
export function makePillar() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: rgb(PILLAR_COLOR), roughness: 0.85 });
  const geos = pillarGeometries();
  for (const key of ['base', 'shaft', 'cap']) {
    const m = new THREE.Mesh(geos[key], stone);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  g.userData = { color: PILLAR_COLOR.slice() };
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
