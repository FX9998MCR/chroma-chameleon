// Prozedurale Low-Poly-Modelle. Alles aus Grundkoerpern gebaut, keine Dateien.
// Einheit: 1 = eine Kachel. Modelle schauen entlang +X.
//
// Eigene Blender-Modelle koennen spaeter ueber GLTFLoader eingehaengt werden:
// dazu die passende make*-Funktion durch den geladenen Scene-Graph ersetzen und
// `userData.mats` (einfaerbbare Materialien) sowie `userData.anim` setzen.

import * as THREE from 'three';

export function rgb(c) {
  return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra });
}

/** Chamaeleon: Rumpf, Kopf mit Helmkamm, Turmaugen, vier Beine, Ringelschwanz. */
export function makeChameleon(colorArr) {
  const g = new THREE.Group();
  const col = rgb(colorArr);
  const body = std(col);
  const belly = std(col.clone().offsetHSL(0, -0.05, 0.12));
  const mats = [body, belly];

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), body);
  torso.rotation.z = Math.PI / 2;
  torso.position.set(0, 0.28, 0);
  torso.scale.set(1, 1.15, 0.9);
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), body);
  head.position.set(0.38, 0.34, 0);
  head.scale.set(1.25, 0.95, 0.9);
  head.castShadow = true;
  g.add(head);

  const crest = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.22, 4), body);
  crest.position.set(0.30, 0.50, 0);
  crest.rotation.z = -0.5;
  g.add(crest);

  // Turmaugen: weisse Halbkugeln mit dunkler Pupille, links und rechts.
  const eyeMat = std(0xf4f4f0, { roughness: 0.35 });
  const pupilMat = std(0x111111, { roughness: 0.3 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), eyeMat);
    eye.position.set(0.42, 0.40, s * 0.13);
    g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), pupilMat);
    pupil.position.set(0.47, 0.41, s * 0.155);
    g.add(pupil);
  }

  // Beine: kurze Zylinder, leicht nach aussen gestellt.
  const legs = [];
  const legGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.22, 6);
  for (const [lx, lz] of [[0.18, 0.16], [0.18, -0.16], [-0.18, 0.16], [-0.18, -0.16]]) {
    const leg = new THREE.Mesh(legGeo, belly);
    leg.position.set(lx, 0.12, lz);
    leg.rotation.x = -lz * 1.4;
    leg.castShadow = true;
    g.add(leg);
    legs.push(leg);
  }

  // Ringelschwanz: Dreiviertel-Torus, hochkant hinter dem Rumpf.
  const tail = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.045, 6, 14, Math.PI * 1.6), body);
  tail.position.set(-0.42, 0.30, 0);
  tail.rotation.y = Math.PI / 2;
  tail.rotation.z = Math.PI * 0.9;
  tail.castShadow = true;
  g.add(tail);

  // Bodenring: nur fuer Teamkameraden/eigenen Spieler sichtbar (wird gesteuert).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.40, 28),
    new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  g.add(ring);

  // Markierungsring (Scan-Treffer): rot, pulsierend.
  const mark = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.50, 28),
    new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
  );
  mark.rotation.x = -Math.PI / 2;
  mark.position.y = 0.02;
  g.add(mark);

  g.userData = { mats, legs, tail, head, torso, ring, mark, kind: 'hider' };
  return g;
}

/** Jaeger: kantiger Mech mit leuchtendem Visier - Chroma-Jaegerdrohne. */
export function makeSeeker() {
  const g = new THREE.Group();
  const shell = std(0x2b2f3a, { metalness: 0.55, roughness: 0.4 });
  const accent = std(0xff8c42, { emissive: 0xff8c42, emissiveIntensity: 0.9, roughness: 0.4 });
  const dark = std(0x15171d, { metalness: 0.4, roughness: 0.6 });
  const mats = [shell];

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 0.46), shell);
  torso.position.set(0, 0.40, 0);
  torso.castShadow = true;
  g.add(torso);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.10, 0.50), dark);
  plate.position.set(-0.05, 0.60, 0);
  g.add(plate);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.24, 0.34), shell);
  head.position.set(0.40, 0.48, 0);
  head.castShadow = true;
  g.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.26), accent);
  visor.position.set(0.56, 0.50, 0);
  g.add(visor);

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28, 5), dark);
  antenna.position.set(0.30, 0.74, 0.10);
  g.add(antenna);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), accent);
  tip.position.set(0.30, 0.89, 0.10);
  g.add(tip);

  const legs = [];
  const legGeo = new THREE.BoxGeometry(0.09, 0.26, 0.09);
  for (const [lx, lz] of [[0.20, 0.20], [0.20, -0.20], [-0.20, 0.20], [-0.20, -0.20]]) {
    const leg = new THREE.Mesh(legGeo, dark);
    leg.position.set(lx, 0.14, lz);
    leg.castShadow = true;
    g.add(leg);
    legs.push(leg);
  }

  // Glimmendes Bodenlicht, damit Jaeger von weitem erkennbar sind.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 24),
    new THREE.MeshBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.012;
  g.add(glow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.40, 28),
    new THREE.MeshBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  g.add(ring);

  g.userData = { mats, legs, head, torso, tail: null, ring, mark: null, visor, kind: 'seeker' };
  return g;
}

/** Saeule mit leuchtendem Ankerring fuer den Zungenhaken. */
export function makePillar() {
  const g = new THREE.Group();
  const stone = std(0x3a4050, { roughness: 0.85 });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 2.1, 10), stone);
  col.position.y = 1.05;
  col.castShadow = true;
  col.receiveShadow = true;
  g.add(col);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.36, 0.18, 10), stone);
  cap.position.y = 2.15;
  cap.castShadow = true;
  g.add(cap);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.40, 0.045, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf0b429, emissive: 0xf0b429, emissiveIntensity: 0.8, roughness: 0.4 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 1.5;
  g.add(ring);
  g.userData = { ring };
  return g;
}

/** Zunge: duenner Zylinder zwischen zwei Punkten, wird pro Frame skaliert. */
export function makeTongue(color = 0xff7aa2) {
  const geo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
  geo.translate(0, 0.5, 0);           // Ursprung am Anfang, Laenge = scale.y
  const mesh = new THREE.Mesh(geo, std(color, { roughness: 0.5 }));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), std(color, { roughness: 0.5 }));
  const g = new THREE.Group();
  g.add(mesh); g.add(tip);
  g.userData = { mesh, tip };
  return g;
}

/** Richtet eine Zunge von a nach b aus. */
export function aimTongue(g, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  g.position.copy(a);
  g.userData.mesh.scale.set(1, Math.max(0.001, len), 1);
  g.userData.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.userData.tip.position.copy(b).sub(a);
}

export const GEO = {
  wall: new THREE.BoxGeometry(1, 1.4, 1),
  bush: new THREE.IcosahedronGeometry(0.52, 1),
  water: new THREE.PlaneGeometry(1, 1),
  splat: new THREE.CircleGeometry(0.28, 12),
  particle: new THREE.SphereGeometry(0.06, 6, 5),
};
