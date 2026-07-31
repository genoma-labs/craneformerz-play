import * as THREE from 'three';
import { net, initLobby, sendState, sendKill } from './net.js';

// ─────────────────────────────────────────────────────────────────────────────
// CRANEFORMERZ - browser build.
// Rebuilt natively for the web (UE5 cannot export to browser - Epic removed
// HTML5 support after 4.23), keeping the design from the Unreal prototype:
// drive a crane truck, grab junk with the boom, fling it into zombies, earn
// Zombie Tokens, survive escalating waves.
// Hand-rolled physics on purpose: the only dynamics needed are gravity, ground
// bounce, and "hook velocity becomes prop velocity on release" (the fling).
// A full physics engine would be a heavier dependency for no gameplay gain.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// EDITION: Z = Zombies (default) · S = Sheeps (family-friendly)
// Chosen by ?mode=s, /s, or the lobby. Same game, same crane, same physics -
// only the enemy, the particles, the voices and the palette change. Built as
// one codebase with a theme object rather than a forked build, so gameplay
// fixes land in both editions automatically.
// ─────────────────────────────────────────────────────────────────────────────
const EDITION = (() => {
  const q = new URLSearchParams(location.search).get('mode');
  const p = location.pathname.toLowerCase();
  const stored = localStorage.getItem('cfz_edition');
  if (q) return q.toLowerCase() === 's' ? 'S' : 'Z';
  if (p.endsWith('/s') || p.includes('/sheep')) return 'S';
  if (stored === 'S') return 'S';
  return 'Z';
})();

const THEME = EDITION === 'S' ? {
  edition: 'S',
  title: 'CRANEFORMER', accent: 'S', tagline: 'S IS FOR SHEEPS',
  accentColor: '#f2f2f2', accentStroke: '#5a5a66',
  enemyWord: 'SHEEP', tokenWord: 'WOOL TOKENS',
  gore: [0xf4f4f4, 0xe6e6ea, 0xd8d8e0],      // wool puffs, not blood
  goreCount: 0.8,
  sky: 0x9fd8ee, ground: 0x74904f,
} : {
  edition: 'Z',
  title: 'CRANEFORMER', accent: 'Z', tagline: 'Z IS FOR ZOMBIES',
  accentColor: '#7fc242', accentStroke: '#14200a',
  enemyWord: 'ZOMBIE', tokenWord: 'ZOMBIE TOKENS',
  gore: [0xb01a1f, 0x6e0f12],
  goreCount: 1.0,
  sky: 0x8fd0e8, ground: 0x6f7d5a,
};

const ARENA = 240;          // half-extent of the world, world units
const GRAB_RANGE = 7.0;
const FLING_BOOST = 1.35;   // makes releasing feel powerful rather than limp
const ZOMBIE_KILL_SPEED = 9;   // prop speed needed to splatter a zombie
const TRUCK_RAM_SPEED = 7;     // truck speed needed to splatter on contact

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEME.sky);
scene.fog = new THREE.Fog(THEME.sky, 120, 260);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// A lost WebGL context otherwise just freezes on a black screen with nothing in the
// console, which reads as "the game crashed" with no cause. Say so out loud, and
// stop the render loop from spinning against a dead context.
let glLost = false;
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  glLost = true;
  const b = document.createElement('div');
  b.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'flex-direction:column;gap:14px;background:rgba(8,10,14,.94);color:#fff;z-index:9999;' +
    "font-family:'Rajdhani',sans-serif;text-align:center;padding:24px";
  b.innerHTML = '<div style="font-size:26px;font-weight:700;letter-spacing:2px">GRAPHICS CONTEXT LOST</div>' +
    '<div style="opacity:.75;max-width:440px">The browser dropped the 3D context — usually low GPU memory. ' +
    'Reload to get back in.</div>' +
    '<button onclick="location.reload()" style="padding:13px 30px;border:none;border-radius:999px;' +
    'background:#f2c200;color:#1a1207;font-weight:700;font-size:15px;cursor:pointer">RELOAD</button>';
  document.body.appendChild(b);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Lighting: bright, punchy, readable ──
scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x6b6b5a, 0.85));
const sun = new THREE.DirectionalLight(0xfff2d5, 2.0);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
sun.shadow.camera.far = 260;
sun.shadow.bias = -0.0008;
scene.add(sun);

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const mat = (c, opts = {}) => new THREE.MeshLambertMaterial({ color: c, ...opts });

// ── Shared particle resources ────────────────────────────────────────────────
// Blood cubes and debris are spawned by the hundreds per minute. Building a new
// BoxGeometry + material for each one leaks GPU memory permanently: scene.remove()
// only detaches from the scene graph, it does NOT free the vertex buffer or the
// compiled shader. That leak exhausted the GPU and killed the WebGL context
// mid-game. Particles now share one unit cube (scaled per instance) and one
// material per colour, so there is nothing left to leak.
//
// Only safe because particle materials are never mutated. The bomb-blink, flame
// and glint materials ARE mutated per frame, so those keep their own instances.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _particleMats = new Map();
function particleMat(c) {
  let m = _particleMats.get(c);
  if (!m) { m = new THREE.MeshLambertMaterial({ color: c }); _particleMats.set(c, m); }
  return m;
}
const MAX_BITS = 900;   // hard ceiling; oldest recycle out so a big wave can't stall

// ── Ground ──
const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2), mat(THEME.ground));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Asphalt yard patch so the ground isn't one flat color
const yard = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), mat(0x3f4148));
yard.rotation.x = -Math.PI / 2;
yard.position.y = 0.02;
yard.receiveShadow = true;
scene.add(yard);

// ── Grass detail: tonal patches + tufts so the ground isn't one flat green ──
const grassTones = [0x63764f, 0x77875c, 0x5a6b47, 0x6d8052];
for (let i = 0; i < 150; i++) {
  const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * (ARENA - 40);
  const px = Math.cos(a) * d, pz = Math.sin(a) * d;
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(6 + Math.random() * 16, 6),
    mat(grassTones[(Math.random() * grassTones.length) | 0])
  );
  patch.rotation.x = -Math.PI / 2;
  patch.rotation.z = Math.random() * 3;
  patch.position.set(px, 0.012 + Math.random() * 0.006, pz);
  patch.receiveShadow = true;
  scene.add(patch);
}
const tuftGeo = box(0.16, 1.1, 0.16);
const tuftMats = [mat(0x4f6b3a), mat(0x5d7a44), mat(0x6b8a4e)];
for (let i = 0; i < 900; i++) {
  const a = Math.random() * Math.PI * 2, d = 26 + Math.random() * (ARENA - 34);
  const px = Math.cos(a) * d, pz = Math.sin(a) * d;
  if (Math.abs(px) < 13 || Math.abs(pz) < 13) continue;          // keep roads clear
  if (Math.hypot(px - 78, pz - 82) < 48) continue;               // not in the lake
  const t = new THREE.Mesh(tuftGeo, tuftMats[(Math.random() * 3) | 0]);
  t.position.set(px, 0.5, pz);
  t.rotation.y = Math.random() * 3;
  t.rotation.z = (Math.random() - 0.5) * 0.4;
  t.scale.y = 0.6 + Math.random() * 1.1;
  scene.add(t);
}
for (let i = 0; i < 70; i++) {                                    // wildflowers
  const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * (ARENA - 40);
  const px = Math.cos(a) * d, pz = Math.sin(a) * d;
  if (Math.hypot(px - 78, pz - 82) < 48) continue;
  const f = new THREE.Mesh(box(0.4, 0.4, 0.4),
    mat([0xf2e14a, 0xe86ea8, 0xe8ffff, 0xd85a3a][(Math.random() * 4) | 0]));
  f.position.set(px, 0.9, pz); scene.add(f);
}

// ── Perimeter walls ──
const wallMat = mat(0x9a5f4a);
for (const [x, z, w, d] of [
  [0, -ARENA, ARENA * 2, 3], [0, ARENA, ARENA * 2, 3],
  [-ARENA, 0, 3, ARENA * 2], [ARENA, 0, 3, ARENA * 2],
]) {
  const wall = new THREE.Mesh(box(w, 9, d), wallMat);
  wall.position.set(x, 4.5, z);
  wall.castShadow = true; wall.receiveShadow = true;
  scene.add(wall);
}

// ── Murals: painted panels on the perimeter walls ──
const muralPalette = [0xd8443a, 0x2f7fb5, 0xf2c200, 0x3f9e5a, 0xe86ea8, 0xf07a1e, 0x7a4a9e];
function mural(x, z, rotY, w, h) {
  const g = new THREE.Group();
  const back = new THREE.Mesh(box(w, h, 0.3), mat(0xe9e2d2));
  back.receiveShadow = true; g.add(back);
  const shapes = 5 + Math.floor(Math.random() * 6);
  for (let i = 0; i < shapes; i++) {
    const sw = w * (0.1 + Math.random() * 0.3), sh = h * (0.12 + Math.random() * 0.45);
    const kind = Math.random();
    let piece;
    if (kind < 0.34) piece = new THREE.Mesh(box(sw, sh, 0.12), mat(muralPalette[(Math.random() * muralPalette.length) | 0]));
    else if (kind < 0.67) piece = new THREE.Mesh(new THREE.CircleGeometry(Math.min(sw, sh) * 0.6, 9), mat(muralPalette[(Math.random() * muralPalette.length) | 0]));
    else piece = new THREE.Mesh(new THREE.ConeGeometry(sw * 0.5, sh, 3), mat(muralPalette[(Math.random() * muralPalette.length) | 0]));
    piece.position.set((Math.random() - 0.5) * (w - sw), (Math.random() - 0.5) * (h - sh), -0.22);
    piece.rotation.z = Math.random() * 3;
    g.add(piece);
  }
  // a crude spray-paint Z, because of course
  const zBar1 = new THREE.Mesh(box(w * 0.22, h * 0.09, 0.14), mat(0x7fc242));
  zBar1.position.set(w * 0.28, h * 0.22, -0.24); g.add(zBar1);
  const zBar2 = new THREE.Mesh(box(w * 0.22, h * 0.09, 0.14), mat(0x7fc242));
  zBar2.position.set(w * 0.28, -h * 0.22, -0.24); g.add(zBar2);
  const zDiag = new THREE.Mesh(box(w * 0.30, h * 0.09, 0.14), mat(0x7fc242));
  zDiag.position.set(w * 0.28, 0, -0.24); zDiag.rotation.z = -0.85; g.add(zDiag);
  g.position.set(x, h / 2 + 1.2, z);
  g.rotation.y = rotY;
  scene.add(g);
}
for (let i = -2; i <= 2; i++) {
  mural(i * 68, -ARENA + 1.7, 0, 42, 7);
  mural(i * 68, ARENA - 1.7, Math.PI, 42, 7);
  mural(-ARENA + 1.7, i * 68, Math.PI / 2, 42, 7);
  mural(ARENA - 1.7, i * 68, -Math.PI / 2, 42, 7);
}

// ── Scenery: warehouses + light poles, so it reads as a place, not a box ──
// Solid obstacles the truck cannot drive through (circle colliders - cheap and
// good enough for blocky geometry; props stay non-solid so you can smash junk).
const obstacles = [];

const rooftops = [];   // filled as buildings are made; props get placed up here later

function building(x, z, w, h, d, color) {
  obstacles.push({ x, z, r: Math.max(w, d) * 0.52, hard: true });
  rooftops.push({ x, z, w, d, top: h + 0.8 });
  const b = new THREE.Mesh(box(w, h, d), mat(color));
  b.position.set(x, h / 2, z);
  b.castShadow = true; b.receiveShadow = true;
  scene.add(b);
  const roof = new THREE.Mesh(box(w + 1.5, 0.8, d + 1.5), mat(0x4a4a55));
  roof.position.set(x, h + 0.4, z);
  roof.castShadow = true;
  scene.add(roof);
  return { x, z, w, d };
}
const buildings = [
  building(-92, -86, 30, 16, 24, 0xc4b393),
  building(-52, -104, 26, 22, 20, 0xa8b8c4),
  building(96, -80, 26, 26, 26, 0xb9a2a2),
  building(58, -110, 30, 14, 22, 0xc9c2a4),
  building(-104, 46, 24, 19, 28, 0xd0bfa0),
  building(112, 58, 32, 17, 24, 0xa9b5bd),
  building(-40, 116, 28, 21, 22, 0xc7b8a8),
  building(44, 122, 26, 15, 26, 0xbfc4b0),
];
for (const [x, z] of [[-60, -60], [60, -60], [-60, 60], [60, 60], [0, -100], [0, 100], [-110, 0], [110, 0]]) {
  const pole = new THREE.Mesh(box(0.6, 14, 0.6), mat(0x555a60));
  pole.position.set(x, 7, z); pole.castShadow = true; scene.add(pole);
  const lamp = new THREE.Mesh(box(3, 0.7, 1.4), mat(0xf7e9a0));
  lamp.position.set(x, 14, z); scene.add(lamp);
}

// ── LAKE (north-east) ──
const LAKE = { x: 78, z: 82, r: 42 };
// Segmented so the vertices can be waved in the animation loop
const lakeGeo = new THREE.CircleGeometry(LAKE.r, 40, 1);
const lake = new THREE.Mesh(lakeGeo, mat(0x2f7fb5, { transparent: true, opacity: 0.9, flatShading: true }));
lake.rotation.x = -Math.PI / 2; lake.position.set(LAKE.x, 0.06, LAKE.z);
lake.receiveShadow = true; scene.add(lake);
const lakeBase = Float32Array.from(lakeGeo.attributes.position.array);

// Sun glitter on the surface
const glints = [];
for (let i = 0; i < 26; i++) {
  const gl = new THREE.Mesh(box(1.4, 0.08, 1.4), mat(0xdff2ff, { transparent: true, opacity: 0.75 }));
  const a = Math.random() * Math.PI * 2, d = Math.random() * (LAKE.r - 4);
  gl.position.set(LAKE.x + Math.cos(a) * d, 0.3, LAKE.z + Math.sin(a) * d);
  gl.userData.phase = Math.random() * 6.28;
  scene.add(gl); glints.push(gl);
}
const shore = new THREE.Mesh(new THREE.RingGeometry(LAKE.r, LAKE.r + 5, 26), mat(0xd8caa0));
shore.rotation.x = -Math.PI / 2; shore.position.set(LAKE.x, 0.04, LAKE.z); scene.add(shore);
for (let i = 0; i < 12; i++) {           // lily pads / rocks for detail
  const a = Math.random() * Math.PI * 2, d = Math.random() * (LAKE.r - 6);
  const pad = new THREE.Mesh(box(2.2, 0.25, 2.2), mat(Math.random() < 0.5 ? 0x3f7a3f : 0x6b6b72));
  pad.position.set(LAKE.x + Math.cos(a) * d, 0.2, LAKE.z + Math.sin(a) * d);
  pad.rotation.y = Math.random() * 3; scene.add(pad);
}

// ── MOUNTAIN (south-west) ──
const MOUNT = { x: -120, z: 120 };
function peak(x, z, r, h, color) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat(color, { flatShading: true }));
  m.position.set(x, h / 2, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.36, h * 0.3, 7), mat(0xf2f6f8, { flatShading: true }));
  cap.position.set(x, h * 0.86, z); scene.add(cap);
  return m;
}
peak(MOUNT.x, MOUNT.z, 52, 78, 0x6b6f5c);
peak(MOUNT.x + 46, MOUNT.z - 26, 34, 52, 0x5f6352);
peak(MOUNT.x - 38, MOUNT.z + 18, 30, 44, 0x74786a);
obstacles.push({ x: MOUNT.x, z: MOUNT.z, r: 46, hard: true });
obstacles.push({ x: MOUNT.x + 46, z: MOUNT.z - 26, r: 30, hard: true });
obstacles.push({ x: MOUNT.x - 38, z: MOUNT.z + 18, r: 26, hard: true });

// ── FOREST (west band + scattered) ──
function tree(x, z, scale = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(box(1.1 * scale, 5 * scale, 1.1 * scale), mat(0x6b4a2a));
  trunk.position.y = 2.5 * scale; trunk.castShadow = true; g.add(trunk);
  const greens = [0x2f6b34, 0x387a3c, 0x275c2c];
  for (let i = 0; i < 3; i++) {
    const s = (4.6 - i * 1.1) * scale;
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(s, 4.4 * scale, 7), mat(greens[i % 3], { flatShading: true }));
    canopy.position.y = (5.5 + i * 2.6) * scale; canopy.castShadow = true; g.add(canopy);
  }
  g.position.set(x, 0, z);
  g.rotation.y = Math.random() * 3;
  scene.add(g);
  obstacles.push({ x, z, r: 1.6 * scale, hard: false });   // trees shudder, don't stop you dead
}
for (let i = 0; i < 90; i++) {
  const a = Math.random() * Math.PI * 2;
  const d = 60 + Math.random() * 85;
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 10) continue;     // not in the lake
  if (Math.hypot(x - MOUNT.x, z - MOUNT.z) < 60) continue;            // not in the mountain
  tree(x, z, 0.8 + Math.random() * 0.9);
}

// ── Roads through the yard, so it reads as a place you drive around ──
for (const [rx, rz, rw, rd] of [[0, 0, 22, ARENA * 2], [0, 0, ARENA * 2, 22]]) {
  const road = new THREE.Mesh(new THREE.PlaneGeometry(rw, rd), mat(0x3a3d44));
  road.rotation.x = -Math.PI / 2; road.position.set(rx, 0.03, rz);
  road.receiveShadow = true; scene.add(road);
}
for (let i = -8; i <= 8; i++) {          // centre-line dashes
  for (const along of [[0, i * 11], [i * 11, 0]]) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 5), mat(0xd8cf9a));
    dash.rotation.x = -Math.PI / 2;
    if (along[0] === 0) dash.position.set(0, 0.05, along[1]);
    else { dash.rotation.z = Math.PI / 2; dash.position.set(along[0], 0.05, 0); }
    scene.add(dash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The crane truck
// ─────────────────────────────────────────────────────────────────────────────
// Modelled on a COPMA 450 knuckle-boom loader crane with a grapple saw:
// white cab, dark chassis, YELLOW slew column behind the cab, dark navy inner
// boom raising steeply, a folding KNUCKLE, a telescoping outer boom, and a
// red grapple at the tip. Colors/proportions taken from the reference photo.
const COL_YELLOW = 0xf5c518;
const BOOM_NAVY = 0x1e2733;
const CAB_WHITE = 0xeef1f4;
const STEEL = 0x39414d;

const truck = new THREE.Group();
scene.add(truck);

// Chassis frame
const chassis = new THREE.Mesh(box(4.6, 1.1, 15), mat(0x2a2f38));
chassis.position.y = 1.9; chassis.castShadow = true; chassis.receiveShadow = true;
truck.add(chassis);

// Cab (white, forward)
const cab = new THREE.Mesh(box(4.6, 3.4, 4.6), mat(CAB_WHITE));
cab.position.set(0, 4.2, -5.0); cab.castShadow = true;
truck.add(cab);
const cabRoof = new THREE.Mesh(box(4.7, 0.35, 4.7), mat(0xdfe4e9));
cabRoof.position.set(0, 5.95, -5.0); truck.add(cabRoof);
const windshield = new THREE.Mesh(box(4.1, 1.5, 0.2), mat(0x1d2b38));
windshield.position.set(0, 4.9, -7.35); truck.add(windshield);
for (const sx of [-2.35, 2.35]) {
  const sideWin = new THREE.Mesh(box(0.2, 1.2, 2.2), mat(0x1d2b38));
  sideWin.position.set(sx, 4.9, -5.4); truck.add(sideWin);
}
const grille = new THREE.Mesh(box(4.2, 1.1, 0.3), mat(0x8b929c));
grille.position.set(0, 3.2, -7.4); truck.add(grille);
for (const sx of [-1.6, 1.6]) {
  const light = new THREE.Mesh(box(0.9, 0.5, 0.25), mat(0xfff3c4));
  light.position.set(sx, 3.9, -7.42); truck.add(light);
}

// Flatbed deck with side rails (where the logs ride)
const deck = new THREE.Mesh(box(4.6, 0.35, 8.0), mat(0x4a4f58));
deck.position.set(0, 2.6, 3.4); deck.castShadow = true; truck.add(deck);
for (const sx of [-2.25, 2.25]) {
  const rail = new THREE.Mesh(box(0.22, 1.0, 8.0), mat(STEEL));
  rail.position.set(sx, 3.2, 3.4); rail.castShadow = true; truck.add(rail);
}
for (const rz of [0.4, 3.4, 6.4]) {
  const stake = new THREE.Mesh(box(0.28, 1.9, 0.28), mat(STEEL));
  stake.position.set(-2.25, 3.6, rz); truck.add(stake);
  const stake2 = stake.clone(); stake2.position.x = 2.25; truck.add(stake2);
}

// Wheels
const wheels = [];
for (const [wx, wz] of [[-2.4, -5.2], [2.4, -5.2], [-2.4, 2.4], [2.4, 2.4], [-2.4, 5.0], [2.4, 5.0]]) {
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 1.0, 16), mat(0x141519));
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(wx, 1.35, wz);
  wheel.castShadow = true;
  truck.add(wheel);
  wheels.push(wheel);
  const hubcap = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.06, 10), mat(0x9aa2ad));
  hubcap.rotation.z = Math.PI / 2; hubcap.position.set(wx, 1.35, wz);
  truck.add(hubcap);
}

// Outriggers / stabilizer legs (visible in the reference, deployed at the base)
for (const [ox, oz] of [[-1, -1.4], [1, -1.4]]) {
  const armOut = new THREE.Mesh(box(6.4, 0.5, 0.7), mat(COL_YELLOW));
  armOut.position.set(0, 2.2, oz); armOut.castShadow = true; truck.add(armOut);
  for (const sx of [-3.0, 3.0]) {
    const leg = new THREE.Mesh(box(0.5, 2.2, 0.6), mat(STEEL));
    leg.position.set(sx, 1.2, oz); leg.castShadow = true; truck.add(leg);
    const foot = new THREE.Mesh(box(1.2, 0.3, 1.2), mat(0x2a2f38));
    foot.position.set(sx, 0.16, oz); truck.add(foot);
  }
}

// ── Knuckle boom crane ──
// Column (slew) — mounted behind the cab, rotates about Y
const craneColumn = new THREE.Group();
craneColumn.position.set(0, 3.0, -1.4);
truck.add(craneColumn);

const columnBase = new THREE.Mesh(box(3.2, 0.8, 3.2), mat(0x2a2f38));
columnBase.position.y = 0.4; columnBase.castShadow = true; craneColumn.add(columnBase);
const column = new THREE.Mesh(box(2.4, 4.4, 2.4), mat(COL_YELLOW));
column.position.y = 3.0; column.castShadow = true; craneColumn.add(column);
// COPMA-style branding stripe on the column
const stripe = new THREE.Mesh(box(2.45, 0.9, 2.45), mat(0x1e2733));
stripe.position.y = 4.6; craneColumn.add(stripe);

// Inner boom — pivots up steeply from the top of the column
const innerPivot = new THREE.Group();
innerPivot.position.y = 5.0;
craneColumn.add(innerPivot);

const INNER_LEN = 11;
const innerBoom = new THREE.Mesh(box(1.5, 1.5, INNER_LEN), mat(BOOM_NAVY));
innerBoom.position.z = INNER_LEN / 2; innerBoom.castShadow = true;
innerPivot.add(innerBoom);
// lift cylinder along the inner boom
const liftCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 5.5, 10), mat(0xb8c0c8));
liftCyl.rotation.x = Math.PI / 2; liftCyl.position.set(0, -1.0, 3.0);
innerPivot.add(liftCyl);

// KNUCKLE — the folding joint that defines a knuckle boom
const knucklePivot = new THREE.Group();
knucklePivot.position.z = INNER_LEN;
innerPivot.add(knucklePivot);
const knuckleHub = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 1.7, 12), mat(COL_YELLOW));
knuckleHub.rotation.z = Math.PI / 2; knuckleHub.castShadow = true;
knucklePivot.add(knuckleHub);

// Outer boom + telescopic sections
const OUTER_LEN = 10;
const outerBoom = new THREE.Mesh(box(1.25, 1.25, OUTER_LEN), mat(BOOM_NAVY));
outerBoom.position.z = OUTER_LEN / 2; outerBoom.castShadow = true;
knucklePivot.add(outerBoom);
const knuckleCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 4.2, 10), mat(0xb8c0c8));
knuckleCyl.rotation.x = Math.PI / 2; knuckleCyl.position.set(0, 0.95, 2.4);
knucklePivot.add(knuckleCyl);

const teleSections = [];
for (let i = 0; i < 3; i++) {
  const w = 1.05 - i * 0.16;
  const sec = new THREE.Mesh(box(w, w, 7), mat(i % 2 ? 0x2b3646 : BOOM_NAVY));
  sec.castShadow = true;
  knucklePivot.add(sec);
  teleSections.push(sec);
}

const grappleAnchor = new THREE.Object3D();
knucklePivot.add(grappleAnchor);

// ── Grapple saw (the red claw at the tip) ──
const grapple = new THREE.Group();
scene.add(grapple);                       // world-space so held props parent cleanly
const grappleHead = new THREE.Mesh(box(1.5, 1.1, 1.5), mat(0xc0392b));
grappleHead.castShadow = true; grapple.add(grappleHead);
const rotator = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 10), mat(0x8b929c));
rotator.position.y = 0.95; grapple.add(rotator);
const jaws = [];
for (let i = 0; i < 2; i++) {
  const jawPivot = new THREE.Group();
  jawPivot.position.set(0, -0.5, 0);
  grapple.add(jawPivot);
  const jaw = new THREE.Mesh(box(0.45, 2.3, 1.4), mat(0xd94f3d));
  jaw.position.set(0, -1.0, (i ? 1 : -1) * 0.55);
  jaw.castShadow = true;
  jawPivot.add(jaw);
  const tip = new THREE.Mesh(box(0.45, 0.7, 1.5), mat(0x9c2f22));
  tip.position.set(0, -2.05, (i ? 1 : -1) * 0.95);
  jawPivot.add(tip);
  jaws.push({ pivot: jawPivot, dir: i ? 1 : -1 });
}
// Saw bar, like the reference's grapple saw
const sawBar = new THREE.Mesh(box(0.16, 0.5, 3.4), mat(0xe8e2b0));
sawBar.position.set(0.85, -0.9, 1.0); grapple.add(sawBar);

const cable = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x141414 })
);
scene.add(cable);

// ─────────────────────────────────────────────────────────────────────────────
// Grabbable junk
// ─────────────────────────────────────────────────────────────────────────────
const props = [];

function makeShark() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(1.6, 1.8, 5.2), mat(0x4a86c8));
  body.castShadow = true; g.add(body);
  const belly = new THREE.Mesh(box(1.62, 0.7, 4.4), mat(0xe8eef2));
  belly.position.y = -0.62; g.add(belly);
  const fin = new THREE.Mesh(box(0.25, 1.5, 1.4), mat(0x3d6fa8));
  fin.position.set(0, 1.5, 0.2); fin.castShadow = true; g.add(fin);
  const tail = new THREE.Mesh(box(0.25, 2.0, 1.2), mat(0x3d6fa8));
  tail.position.set(0, 0.7, -2.9); g.add(tail);
  const jaw = new THREE.Mesh(box(1.3, 0.35, 0.9), mat(0xffffff));
  jaw.position.set(0, -0.5, 2.4); g.add(jaw);
  return g;
}
function makeBarrel() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.6, 12), mat(0xd8442f));
  b.castShadow = true; g.add(b);
  for (const y of [-0.7, 0.7]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.17, 1.17, 0.22, 12), mat(0xf0e2c0));
    ring.position.y = y; g.add(ring);
  }
  return g;
}
function makePotty() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(box(2.0, 3.4, 2.0), mat(0x2f9e6b));
  b.castShadow = true; g.add(b);
  const roof = new THREE.Mesh(box(2.2, 0.3, 2.2), mat(0xffffff));
  roof.position.y = 1.85; g.add(roof);
  const door = new THREE.Mesh(box(1.5, 2.4, 0.12), mat(0x24805a));
  door.position.set(0, -0.2, 1.02); g.add(door);
  return g;
}
function makeCrate() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(box(2.2, 2.2, 2.2), mat(0xb2793d));
  b.castShadow = true; g.add(b);
  for (const [ax, ay] of [[0, 1.12], [0, -1.12]]) {
    const slat = new THREE.Mesh(box(2.24, 0.28, 2.24), mat(0x8c5c2a));
    slat.position.set(ax, ay, 0); g.add(slat);
  }
  return g;
}
function makeCone() {
  const g = new THREE.Group();
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.85, 2.2, 10), mat(0xff6a1e));
  c.castShadow = true; c.position.y = 0.2; g.add(c);
  const base = new THREE.Mesh(box(1.9, 0.25, 1.9), mat(0x2b2b30));
  base.position.y = -0.95; g.add(base);
  return g;
}

function makeCow() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(1.9, 1.9, 3.6), mat(0xf2f0ea));
  body.castShadow = true; g.add(body);
  for (const [px, pz, ps] of [[-0.5, -0.6, 0.9], [0.6, 0.7, 1.1], [0.2, -1.3, 0.7]]) {
    const patch = new THREE.Mesh(box(1.94, ps, ps * 1.2), mat(0x2b2b30));
    patch.position.set(px * 0.5, 0.2, pz); g.add(patch);
  }
  const head = new THREE.Mesh(box(1.2, 1.2, 1.3), mat(0xf2f0ea));
  head.position.set(0, 0.5, -2.3); head.castShadow = true; g.add(head);
  const snout = new THREE.Mesh(box(0.9, 0.7, 0.5), mat(0xf0b8bd));
  snout.position.set(0, 0.2, -3.0); g.add(snout);
  for (const hx of [-0.45, 0.45]) {
    const horn = new THREE.Mesh(box(0.22, 0.5, 0.22), mat(0xe8dcc0));
    horn.position.set(hx, 1.25, -2.3); g.add(horn);
  }
  for (const [lx, lz] of [[-0.65, -1.1], [0.65, -1.1], [-0.65, 1.2], [0.65, 1.2]]) {
    const leg = new THREE.Mesh(box(0.42, 1.5, 0.42), mat(0x33333a));
    leg.position.set(lx, -1.5, lz); g.add(leg);
  }
  const udder = new THREE.Mesh(box(0.8, 0.5, 0.9), mat(0xf0b8bd));
  udder.position.set(0, -1.05, 0.9); g.add(udder);
  return g;
}
function makeIceCream() {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.6, 10), mat(0xd9a441));
  cone.rotation.x = Math.PI; cone.position.y = -0.9; cone.castShadow = true; g.add(cone);
  const s1 = new THREE.Mesh(new THREE.DodecahedronGeometry(1.15, 0), mat(0xf7a8c4));
  s1.position.y = 0.7; s1.castShadow = true; g.add(s1);
  const s2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.95, 0), mat(0xfff2c2));
  s2.position.set(0.25, 1.9, 0.1); s2.castShadow = true; g.add(s2);
  const cherry = new THREE.Mesh(new THREE.DodecahedronGeometry(0.35, 0), mat(0xd8202a));
  cherry.position.set(0.2, 2.8, 0.1); g.add(cherry);
  return g;
}
function makeCar() {
  const g = new THREE.Group();
  const c = [0x3d7fd8, 0xd84f3d, 0x4fd87f, 0xd8c93d][(Math.random() * 4) | 0];
  const body = new THREE.Mesh(box(2.4, 1.2, 5.2), mat(c));
  body.castShadow = true; g.add(body);
  const cabin = new THREE.Mesh(box(2.2, 1.1, 2.6), mat(0x2b3a48));
  cabin.position.set(0, 1.1, -0.2); cabin.castShadow = true; g.add(cabin);
  for (const [wx, wz] of [[-1.25, -1.7], [1.25, -1.7], [-1.25, 1.7], [1.25, 1.7]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.4, 12), mat(0x15151a));
    w.rotation.z = Math.PI / 2; w.position.set(wx, -0.55, wz); g.add(w);
  }
  return g;
}
function makeGnome() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(1.1, 1.4, 1.1), mat(0x3f7fd8));
  body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(box(0.9, 0.8, 0.9), mat(0xf0c9a0));
  head.position.y = 1.1; g.add(head);
  const beard = new THREE.Mesh(box(0.85, 0.7, 0.4), mat(0xf2f2f2));
  beard.position.set(0, 0.85, -0.42); g.add(beard);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.4, 8), mat(0xd8202a));
  hat.position.y = 2.1; hat.castShadow = true; g.add(hat);
  return g;
}
function makeDuck() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(1.7, 1.5, 2.6), mat(0xffd83d));
  body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(box(1.1, 1.1, 1.1), mat(0xffd83d));
  head.position.set(0, 1.2, -0.9); head.castShadow = true; g.add(head);
  const beak = new THREE.Mesh(box(0.7, 0.35, 0.8), mat(0xff8c1a));
  beak.position.set(0, 1.05, -1.7); g.add(beak);
  for (const ex of [-0.3, 0.3]) {
    const eye = new THREE.Mesh(box(0.18, 0.18, 0.12), mat(0x121212));
    eye.position.set(ex, 1.45, -1.42); g.add(eye);
  }
  return g;
}

function makeLollipop() {
  const g = new THREE.Group();
  const stick = new THREE.Mesh(box(0.28, 3.4, 0.28), mat(0xf5f0e6));
  stick.position.y = -1.4; stick.castShadow = true; g.add(stick);
  const swirlA = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.45, 14), mat(0xff3b8d));
  swirlA.rotation.x = Math.PI / 2; swirlA.position.y = 0.9; swirlA.castShadow = true; g.add(swirlA);
  // candy swirl stripes
  for (let i = 0; i < 4; i++) {
    const stripe = new THREE.Mesh(box(0.35, 2.7, 0.5), mat(i % 2 ? 0xffffff : 0x3bd8ff));
    stripe.position.y = 0.9; stripe.rotation.z = (i * Math.PI) / 4; g.add(stripe);
  }
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.12, 14), mat(0xfff6c2, { transparent: true, opacity: 0.55 }));
  wrap.rotation.x = Math.PI / 2; wrap.position.set(0, 0.9, 0.3); g.add(wrap);
  return g;
}

const PROP_KINDS = [
  { make: makeShark, mass: 2.6, r: 2.6, snd: 'flesh' },
  { make: makeLollipop, mass: 1.1, r: 1.8, snd: 'candy' },
  { make: makeCow, mass: 3.0, r: 2.2, snd: 'flesh' },
  { make: makeBarrel, mass: 1.6, r: 1.4, snd: 'metal' },
  { make: makeIceCream, mass: 1.2, r: 1.6, snd: 'candy' },
  { make: makePotty, mass: 2.2, r: 1.7, snd: 'plastic' },
  { make: makeCar, mass: 4.0, r: 2.6, snd: 'metal' },
  { make: makeCrate, mass: 1.4, r: 1.4, snd: 'wood' },
  { make: makeDuck, mass: 1.3, r: 1.4, snd: 'plastic' },
  { make: makeGnome, mass: 1.0, r: 1.2, snd: 'glassy' },
  { make: makeCone, mass: 0.7, r: 1.0, snd: 'plastic' },
];

function spawnProp(kind, x, z) {
  const k = PROP_KINDS[kind % PROP_KINDS.length];
  const mesh = k.make();
  mesh.position.set(x, k.r + 0.4, z);
  scene.add(mesh);
  const p = {
    mesh, vel: new THREE.Vector3(), r: k.r, mass: k.mass,
    held: false, spin: new THREE.Vector3(), grounded: false, snd: k.snd || 'wood',
  };
  props.push(p);
  return p;
}

// Scatter the world with grabbable junk
for (let i = 0; i < 70; i++) {
  const a = Math.random() * Math.PI * 2;
  const d = 10 + Math.random() * 130;
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  if (Math.hypot(x - 78, z - 82) < 48) continue;      // keep junk out of the lake
  spawnProp(i, x, z);
}

// ── Rooftop loot: the good weapons sit on the buildings, so extending the
// telescope up there is worth doing (gives the reach axis a real purpose) ──
let roofKind = 0;
for (const rt of rooftops) {
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const px = rt.x + (Math.random() - 0.5) * (rt.w - 4);
    const pz = rt.z + (Math.random() - 0.5) * (rt.d - 4);
    const p = spawnProp(roofKind++, px, pz);
    p.mesh.position.y = rt.top + p.r + 0.4;
    p.restY = rt.top + p.r * 0.55;      // rests on the roof, not the ground
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zombies
// ─────────────────────────────────────────────────────────────────────────────
const zombies = [];
const SHEEP_TYPES = [
  { name: 'lamb',   color: 0xf4f4f4, skin: 0x33333a, speed: 4.2, hp: 1,  scale: 1.0,  voice: 'baa' },
  { name: 'ram',    color: 0xeae6dc, skin: 0x2b2b30, speed: 7.6, hp: 1,  scale: 0.88, voice: 'baaHi' },
  { name: 'woolly', color: 0xdcd6c8, skin: 0x3a3a42, speed: 3.0, hp: 9,  scale: 1.4,  voice: 'baaLow' },
  { name: 'punkram',color: 0xf0e2ee, skin: 0x33333a, speed: 5.2, hp: 4,  scale: 1.0,  hair: 0xff4fa3, voice: 'baaHi' },
  { name: 'bikeram',color: 0xcfcfd6, skin: 0x2b2b33, speed: 11.0, hp: 4, scale: 1.0,  bike: true, voice: 'rev' },
  { name: 'MEGA RAM', color: 0xfaf6ea, skin: 0x4a3b2a, speed: 2.6, hp: 70, scale: 3.6, boss: true, voice: 'baaTitan' },
];

const ZOMBIE_TYPES_Z = [
  { name: 'shambler', color: 0x6f9e4a, skin: 0x86b565, speed: 4.2, hp: 1, scale: 1.0 },
  { name: 'runner', color: 0x4a7f9e, skin: 0x7fae8a, speed: 7.6, hp: 1, scale: 0.88 },
  { name: 'brute', color: 0x9e4a6f, skin: 0x8f7a6a, speed: 3.0, hp: 9, scale: 1.4, voice: 'deep' },
  { name: 'punk', color: 0x7a4a9e, skin: 0x9ab87f, speed: 5.2, hp: 4, scale: 1.0, hair: 0xff4fa3, voice: 'shriek' },
  { name: 'biker', color: 0x2b2b33, skin: 0x8fae72, speed: 11.0, hp: 4, scale: 1.0, bike: true, voice: 'rev' },
  { name: 'BOSS', color: 0x4a3b2a, skin: 0x6f8f4a, speed: 2.6, hp: 70, scale: 3.6, boss: true, voice: 'titan' },
];

const ZOMBIE_TYPES = THEME.edition === 'S' ? SHEEP_TYPES : ZOMBIE_TYPES_Z;

function makeSheep(typeIdx) {
  const t = ZOMBIE_TYPES[typeIdx];
  const g = new THREE.Group();
  // fluffy body built from overlapping wool lumps
  const body = new THREE.Mesh(box(1.9, 1.8, 3.0), mat(t.color));
  body.position.y = 2.0; body.castShadow = true; g.add(body);
  for (const [lx, ly, lz] of [[-0.7,0.7,-0.9],[0.7,0.75,0.4],[0,0.8,1.1],[-0.5,0.6,1.0],[0.6,0.65,-1.0]]) {
    const lump = new THREE.Mesh(box(1.3, 1.2, 1.3), mat(t.color));
    lump.position.set(lx, 2.0 + ly * 0.5, lz); lump.castShadow = true; g.add(lump);
  }
  const head = new THREE.Mesh(box(0.95, 1.0, 1.1), mat(t.skin));
  head.position.set(0, 2.3, -2.0); head.castShadow = true; g.add(head);
  const snout = new THREE.Mesh(box(0.6, 0.45, 0.5), mat(0x55555f));
  snout.position.set(0, 2.1, -2.6); g.add(snout);
  for (const ex of [-0.26, 0.26]) {
    const eye = new THREE.Mesh(box(0.16, 0.16, 0.1), mat(0xffffff));
    eye.position.set(ex, 2.5, -2.56); g.add(eye);
  }
  const fringe = new THREE.Mesh(box(1.0, 0.5, 0.5), mat(t.color));
  fringe.position.set(0, 2.85, -1.85); g.add(fringe);
  if (t.hair) {
    const dye = new THREE.Mesh(box(1.05, 0.5, 0.55), mat(t.hair));
    dye.position.set(0, 2.9, -1.85); g.add(dye);
  }
  if (t.boss) {                       // MEGA RAM: big curled horns
    for (const hx of [-0.62, 0.62]) {
      const h1 = new THREE.Mesh(box(0.42, 0.42, 0.9), mat(0xd8c9a0));
      h1.position.set(hx, 2.65, -1.75); h1.castShadow = true; g.add(h1);
      const h2 = new THREE.Mesh(box(0.4, 0.75, 0.4), mat(0xd8c9a0));
      h2.position.set(hx * 1.25, 2.25, -1.4); g.add(h2);
    }
  }
  // ears double as the "arms" the shared animator wobbles
  const armL = new THREE.Mesh(box(0.7, 0.22, 0.42), mat(t.skin));
  armL.position.set(-0.75, 2.6, -1.95); armL.castShadow = true; g.add(armL);
  const armR = armL.clone(); armR.position.x = 0.75; g.add(armR);
  // front legs are the animated pair
  const legL = new THREE.Mesh(box(0.42, 1.6, 0.42), mat(t.skin));
  legL.position.set(-0.6, 0.8, -1.0); g.add(legL);
  const legR = legL.clone(); legR.position.x = 0.6; g.add(legR);
  for (const bx of [-0.6, 0.6]) {     // static back legs
    const bl = new THREE.Mesh(box(0.42, 1.6, 0.42), mat(t.skin));
    bl.position.set(bx, 0.8, 1.1); g.add(bl);
  }
  const tail = new THREE.Mesh(box(0.4, 0.6, 0.35), mat(t.color));
  tail.position.set(0, 2.4, 1.6); g.add(tail);
  if (t.bike) {
    const frame = new THREE.Mesh(box(0.7, 0.6, 3.2), mat(0x7a1f1f));
    frame.position.set(0, 0.95, 0.1); frame.castShadow = true; g.add(frame);
    for (const wz of [-1.35, 1.35]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.3, 12), mat(0x121216));
      w.rotation.z = Math.PI / 2; w.position.set(0, 0.85, wz); w.castShadow = true; g.add(w);
    }
  }
  g.scale.setScalar(t.scale);
  return { group: g, legL, legR, armL, armR };
}

function makeZombieZ(typeIdx) {
  const t = ZOMBIE_TYPES[typeIdx];
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(1.5, 2.2, 0.9), mat(t.color));
  body.position.y = 1.7; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(box(1.0, 1.0, 1.0), mat(t.skin));
  head.position.y = 3.35; head.castShadow = true; g.add(head);
  // sunken eyes
  for (const ex of [-0.26, 0.26]) {
    const eye = new THREE.Mesh(box(0.2, 0.2, 0.1), mat(0x1a1a10));
    eye.position.set(ex, 3.45, -0.52); g.add(eye);
  }
  const jaw = new THREE.Mesh(box(0.7, 0.22, 0.2), mat(0xd8d2c0));
  jaw.position.set(0, 2.98, -0.46); g.add(jaw);

  if (t.hair) {          // punk variant: bright mohawk + ponytail silhouette
    const mohawk = new THREE.Mesh(box(0.18, 0.5, 1.0), mat(t.hair));
    mohawk.position.y = 4.0; g.add(mohawk);
    const tail = new THREE.Mesh(box(0.35, 1.1, 0.35), mat(t.hair));
    tail.position.set(0, 3.3, 0.68); g.add(tail);
  }
  if (t.boss) {          // BOSS: horned, armored, unmistakable
    for (const hx of [-0.5, 0.5]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 6), mat(0xe8dcc0));
      horn.position.set(hx, 4.1, 0); horn.rotation.z = hx > 0 ? -0.4 : 0.4;
      g.add(horn);
    }
    const armor = new THREE.Mesh(box(1.9, 1.2, 1.1), mat(0x6b5a3a));
    armor.position.y = 2.3; armor.castShadow = true; g.add(armor);
    for (const sx of [-1.2, 1.2]) {
      const pad = new THREE.Mesh(box(0.7, 0.7, 1.1), mat(0x8a7548));
      pad.position.set(sx, 2.85, 0); g.add(pad);
    }
  }

  const armL = new THREE.Mesh(box(0.42, 1.7, 0.42), mat(t.color));
  armL.position.set(-1.05, 2.15, 0.45); armL.rotation.x = -1.2; armL.castShadow = true; g.add(armL);
  const armR = armL.clone(); armR.position.x = 1.05; g.add(armR);
  const legL = new THREE.Mesh(box(0.55, 1.5, 0.55), mat(0x3f4a55));
  legL.position.set(-0.42, 0.75, 0); g.add(legL);
  const legR = legL.clone(); legR.position.x = 0.42; g.add(legR);

  if (t.bike) {          // motorcycle zombie
    const frame = new THREE.Mesh(box(0.7, 0.6, 3.2), mat(0x7a1f1f));
    frame.position.set(0, 0.95, 0.1); frame.castShadow = true; g.add(frame);
    for (const wz of [-1.35, 1.35]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.3, 12), mat(0x121216));
      w.rotation.z = Math.PI / 2; w.position.set(0, 0.85, wz); w.castShadow = true; g.add(w);
    }
    const bars = new THREE.Mesh(box(1.5, 0.14, 0.14), mat(0xb0b6bd));
    bars.position.set(0, 1.6, -1.2); g.add(bars);
    legL.rotation.x = -1.1; legR.rotation.x = -1.1;
    legL.position.set(-0.55, 1.0, -0.35); legR.position.set(0.55, 1.0, -0.35);
  }

  g.scale.setScalar(t.scale);
  return { group: g, legL, legR, armL, armR };
}

const makeZombie = THEME.edition === 'S' ? makeSheep : makeZombieZ;

function spawnZombie() {
  // Harder types unlock as waves climb
  let pool = [0];
  if (state.wave >= 2) pool.push(1);
  if (state.wave >= 3) pool.push(1, 2);
  if (state.wave >= 4) pool.push(3);
  if (state.wave >= 5) pool.push(4);          // biker
  // BOSS every 5th wave, only one alive at a time
  let typeIdx;
  if (state.wave % 5 === 0 && !zombies.some(z => !z.dead && z.isBoss)) {
    typeIdx = 5;
    toast(THEME.edition === 'S' ? '⚠ MEGA RAM' : '⚠ MEGA ZOMBIE');
  } else {
    typeIdx = pool[(Math.random() * pool.length) | 0];
  }
  const t = ZOMBIE_TYPES[typeIdx];
  const parts = makeZombie(typeIdx);
  const edge = Math.floor(Math.random() * 4);
  const along = (Math.random() - 0.5) * ARENA * 1.7;
  const pos = [
    new THREE.Vector3(along, 0, -ARENA + 6),
    new THREE.Vector3(along, 0, ARENA - 6),
    new THREE.Vector3(-ARENA + 6, 0, along),
    new THREE.Vector3(ARENA - 6, 0, along),
  ][edge];
  parts.group.position.copy(pos);
  scene.add(parts.group);
  zombies.push({
    ...parts, vel: new THREE.Vector3(), speed: t.speed, hp: t.hp, maxHp: t.hp,
    dead: false, deadT: 0, walk: Math.random() * 10, scale: t.scale,
    isBoss: !!t.boss, launch: null, voice: t.voice || 'normal',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Birds - low-poly flocks circling the world
// ─────────────────────────────────────────────────────────────────────────────
const birds = [];
function makeBird(x, y, z) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(0.5, 0.4, 1.3), mat(0x2f3540));
  g.add(body);
  const wingL = new THREE.Mesh(box(2.2, 0.1, 0.7), mat(0x3d4550));
  wingL.position.x = -1.3; g.add(wingL);
  const wingR = new THREE.Mesh(box(2.2, 0.1, 0.7), mat(0x3d4550));
  wingR.position.x = 1.3; g.add(wingR);
  const beak = new THREE.Mesh(box(0.16, 0.16, 0.4), mat(0xe8a33d));
  beak.position.z = -0.82; g.add(beak);
  g.position.set(x, y, z);
  scene.add(g);
  birds.push({
    g, wingL, wingR,
    cx: x, cz: z, radius: 26 + Math.random() * 55,
    ang: Math.random() * 6.28, speed: 0.16 + Math.random() * 0.22,
    y, bob: Math.random() * 6.28, flap: Math.random() * 6.28,
  });
}
for (let i = 0; i < 16; i++) {
  const a = Math.random() * Math.PI * 2, d = Math.random() * 150;
  makeBird(Math.cos(a) * d, 26 + Math.random() * 26, Math.sin(a) * d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ally crane trucks - drive close and they join the fight, flinging junk too
// ─────────────────────────────────────────────────────────────────────────────
const allies = [];
function makeAllyTruck(x, z, color) {
  const g = new THREE.Group();
  const chassisA = new THREE.Mesh(box(4.2, 1.0, 12), mat(0x2a2f38));
  chassisA.position.y = 1.8; chassisA.castShadow = true; g.add(chassisA);
  const cabA = new THREE.Mesh(box(4.2, 3.0, 4.0), mat(color));
  cabA.position.set(0, 3.9, -4.0); cabA.castShadow = true; g.add(cabA);
  const winA = new THREE.Mesh(box(3.8, 1.3, 0.2), mat(0x1d2b38));
  winA.position.set(0, 4.5, -6.05); g.add(winA);
  for (const [wx, wz] of [[-2.2, -4.2], [2.2, -4.2], [-2.2, 2.0], [2.2, 2.0], [-2.2, 4.4], [2.2, 4.4]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.9, 14), mat(0x141519));
    w.rotation.z = Math.PI / 2; w.position.set(wx, 1.2, wz); w.castShadow = true; g.add(w);
  }
  // simplified knuckle boom
  const colA = new THREE.Mesh(box(2.0, 3.8, 2.0), mat(COL_YELLOW));
  colA.position.set(0, 4.6, -0.8); colA.castShadow = true; g.add(colA);
  const armPivot = new THREE.Group();
  armPivot.position.set(0, 6.2, -0.8); g.add(armPivot);
  const innerA = new THREE.Mesh(box(1.2, 1.2, 8), mat(BOOM_NAVY));
  innerA.position.z = 4; innerA.castShadow = true; armPivot.add(innerA);
  const knuckleA = new THREE.Group();
  knuckleA.position.z = 8; armPivot.add(knuckleA);
  const hubA = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.4, 10), mat(COL_YELLOW));
  hubA.rotation.z = Math.PI / 2; knuckleA.add(hubA);
  const outerA = new THREE.Mesh(box(1.0, 1.0, 8), mat(BOOM_NAVY));
  outerA.position.z = 4; outerA.castShadow = true; knuckleA.add(outerA);
  const grapA = new THREE.Mesh(box(1.2, 1.0, 1.2), mat(0xc0392b));
  grapA.position.z = 8.4; knuckleA.add(grapA);
  armPivot.rotation.x = -0.85;
  knuckleA.rotation.x = 1.5;
  g.position.set(x, 0, z);
  g.rotation.y = Math.random() * 6.28;
  scene.add(g);
  const ally = {
    g, armPivot, knuckleA, grapA, active: false, cooldown: 0,
    carrying: null, carryT: 0, heading: g.rotation.y,
  };
  allies.push(ally);
  return ally;
}
makeAllyTruck(-120, -40, 0x2f7fb5);
makeAllyTruck(130, 20, 0x9e4a3a);
makeAllyTruck(-30, 140, 0x3f9e5a);
makeAllyTruck(150, -130, 0xc9a23a);

// ─────────────────────────────────────────────────────────────────────────────
// Zombie towers - perched zombies that lob arrows and vomit, then leap down
// ─────────────────────────────────────────────────────────────────────────────
const towers = [];
const projectiles = [];
function buildTower(x, z) {
  const g = new THREE.Group();
  const H = 22;
  const shaft = new THREE.Mesh(box(7, H, 7), mat(0x6b6155));
  shaft.position.y = H / 2; shaft.castShadow = true; shaft.receiveShadow = true; g.add(shaft);
  for (let i = 1; i < 4; i++) {           // stone banding
    const band = new THREE.Mesh(box(7.4, 0.6, 7.4), mat(0x574f45));
    band.position.y = (H / 4) * i; g.add(band);
  }
  const deckT = new THREE.Mesh(box(10, 0.8, 10), mat(0x4f4840));
  deckT.position.y = H; deckT.castShadow = true; g.add(deckT);
  for (const [bx, bz] of [[-4.6, 0], [4.6, 0], [0, -4.6], [0, 4.6]]) {
    const bat = new THREE.Mesh(box(bx ? 0.9 : 10, 2.2, bz ? 0.9 : 10), mat(0x5e564b));
    bat.position.set(bx, H + 1.5, bz); g.add(bat);
  }
  const flag = new THREE.Mesh(box(0.2, 4, 0.2), mat(0x3a3630));
  flag.position.set(0, H + 4, 0); g.add(flag);
  const cloth = new THREE.Mesh(box(2.6, 1.6, 0.1), mat(0x7fc242));
  cloth.position.set(1.3, H + 5, 0); g.add(cloth);
  g.position.set(x, 0, z);
  scene.add(g);
  obstacles.push({ x, z, r: 5.6, hard: true });
  towers.push({ g, x, z, top: H + 2.4, cooldown: 2 + Math.random() * 3, occupants: 2 + Math.floor(Math.random() * 2), leapT: 6 + Math.random() * 8 });
}
buildTower(-70, -95); buildTower(96, -18); buildTower(-118, 78); buildTower(28, -150);

function towerProjectile(from, to, kind) {
  const g = new THREE.Group();
  if (kind === 'arrow') {
    const shaftA = new THREE.Mesh(box(0.14, 0.14, 2.2), mat(0x8a6a3a));
    g.add(shaftA);
    const headA = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.7, 5), mat(0xb8bcc2));
    headA.rotation.x = -Math.PI / 2; headA.position.z = 1.35; g.add(headA);
    const fl = new THREE.Mesh(box(0.06, 0.5, 0.5), mat(0xd8443a));
    fl.position.z = -1.0; g.add(fl);
  } else {
    for (let i = 0; i < 4; i++) {
      const blob = new THREE.Mesh(box(0.5 + Math.random() * 0.4, 0.5, 0.5), mat(0x8fbf3a));
      blob.position.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.9);
      g.add(blob);
    }
  }
  g.position.copy(from);
  scene.add(g);
  const dir = to.clone().sub(from);
  const flight = Math.max(0.75, dir.length() / (kind === 'arrow' ? 52 : 30));
  const vel = dir.divideScalar(flight);
  vel.y += 0.5 * 26 * flight;
  projectiles.push({ g, vel, kind, life: 7 });
  sfx(kind === 'arrow' ? 880 : 260, 0.12, kind === 'arrow' ? 'triangle' : 'sawtooth', 0.07,
      kind === 'arrow' ? 420 : 120);
}

// ── Buildings that catch fire ──
const fires = [];
function igniteBuilding(rt) {
  if (rt.burning) return;
  rt.burning = true;
  const f = { rt, t: 0, flames: [] };
  for (let i = 0; i < 14; i++) {
    const fl = new THREE.Mesh(box(1.6, 2.6, 1.6),
      mat([0xff9d20, 0xffd24a, 0xd8443a][(Math.random() * 3) | 0], { transparent: true, opacity: 0.9 }));
    fl.position.set(
      rt.x + (Math.random() - 0.5) * rt.w,
      rt.top + 1 + Math.random() * 2,
      rt.z + (Math.random() - 0.5) * rt.d
    );
    fl.userData.phase = Math.random() * 6.28;
    fl.userData.baseY = fl.position.y;
    scene.add(fl);
    f.flames.push(fl);
  }
  const smoke = new THREE.Mesh(box(6, 10, 6), mat(0x3a3a42, { transparent: true, opacity: 0.32 }));
  smoke.position.set(rt.x, rt.top + 10, rt.z);
  scene.add(smoke); f.smoke = smoke;
  fires.push(f);
  toast('BUILDING ABLAZE');
  if (actx) {
    const t0 = actx.currentTime;
    const o = actx.createOscillator(), g2 = actx.createGain(), fi = actx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(90, t0);
    fi.type = 'lowpass'; fi.frequency.setValueAtTime(500, t0);
    g2.gain.setValueAtTime(0.14, t0); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    o.connect(fi); fi.connect(g2); g2.connect(actx.destination);
    o.start(t0); o.stop(t0 + 1.45);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zombie trucks - hostile rigs that hunt the player and ram
// ─────────────────────────────────────────────────────────────────────────────
const zTrucks = [];
function spawnZombieTruck() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(4.4, 2.2, 11), mat(0x4a3b46));
  body.position.y = 2.4; body.castShadow = true; g.add(body);
  const cabZ = new THREE.Mesh(box(4.4, 2.8, 4.0), mat(0x5c2f38));
  cabZ.position.set(0, 4.4, -3.4); cabZ.castShadow = true; g.add(cabZ);
  // boarded-up windscreen
  for (let i = 0; i < 3; i++) {
    const plank = new THREE.Mesh(box(4.2, 0.5, 0.2), mat(0x6b4a2a));
    plank.position.set(0, 4.0 + i * 0.75, -5.45); plank.rotation.z = (Math.random() - .5) * .18;
    g.add(plank);
  }
  // spiked ram bar
  const ram = new THREE.Mesh(box(5.0, 1.0, 0.6), mat(0x8a8f98));
  ram.position.set(0, 2.2, -5.9); ram.castShadow = true; g.add(ram);
  for (const sx of [-1.7, 0, 1.7]) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.6, 5), mat(0xb8bcc2));
    spike.rotation.x = -Math.PI / 2; spike.position.set(sx, 2.2, -6.8); g.add(spike);
  }
  for (const [wx, wz] of [[-2.4, -3.4], [2.4, -3.4], [-2.4, 3.2], [2.4, 3.2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.95, 12), mat(0x141519));
    w.rotation.z = Math.PI / 2; w.position.set(wx, 1.3, wz); w.castShadow = true; g.add(w);
  }
  // a zombie hanging out of the cab
  const zHead = new THREE.Mesh(box(0.9, 0.9, 0.9), mat(0x86b565));
  zHead.position.set(-2.3, 4.6, -3.4); g.add(zHead);
  const a = Math.random() * Math.PI * 2;
  g.position.set(truck.position.x + Math.cos(a) * 130, 0, truck.position.z + Math.sin(a) * 130);
  scene.add(g);
  zTrucks.push({ g, hp: 12, speed: 17 + Math.random() * 6, hitCd: 0, heading: 0 });
  toast(THEME.edition === 'S' ? 'SHEEP TRUCK INBOUND' : 'ZOMBIE TRUCK INBOUND');
  if (actx) {                       // diesel horn
    const t0 = actx.currentTime;
    const o = actx.createOscillator(), gg = actx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(105, t0);
    gg.gain.setValueAtTime(0.16, t0); gg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    o.connect(gg); gg.connect(actx.destination); o.start(t0); o.stop(t0 + 1.15);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bomber drones - hostile quadcopters that hover over the truck and drop bombs
// ─────────────────────────────────────────────────────────────────────────────
const drones = [];
const bombs = [];
function spawnDrone() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(box(2.2, 0.7, 2.2), mat(0x2b3038));
  body.castShadow = true; g.add(body);
  const eye = new THREE.Mesh(box(0.8, 0.35, 0.3), mat(0xff3b30));
  eye.position.set(0, 0, -1.15); g.add(eye);
  const rotors = [];
  for (const [ax, az] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
    const arm = new THREE.Mesh(box(1.4, 0.2, 0.3), mat(0x3d444e));
    arm.position.set(ax * 0.55, 0, az * 0.55);
    arm.rotation.y = Math.atan2(az, ax); g.add(arm);
    const rotor = new THREE.Mesh(box(2.4, 0.09, 0.28), mat(0x8f98a3));
    rotor.position.set(ax, 0.42, az); g.add(rotor);
    rotors.push(rotor);
  }
  const hangar = new THREE.Mesh(box(0.9, 0.6, 0.9), mat(0x7a2f2f));
  hangar.position.y = -0.62; g.add(hangar);
  const a = Math.random() * Math.PI * 2;
  g.position.set(truck.position.x + Math.cos(a) * 90, 34 + Math.random() * 10, truck.position.z + Math.sin(a) * 90);
  scene.add(g);
  drones.push({ g, rotors, cooldown: 1.5 + Math.random() * 2, hp: 2, bob: Math.random() * 6.28 });
}

function dropBomb(pos) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(box(0.9, 1.3, 0.9), mat(0x22262c));
  shell.castShadow = true; g.add(shell);
  const fin = new THREE.Mesh(box(1.3, 0.4, 0.1), mat(0xd8443a));
  fin.position.y = -0.7; g.add(fin);
  const fin2 = new THREE.Mesh(box(0.1, 0.4, 1.3), mat(0xd8443a));
  fin2.position.y = -0.7; g.add(fin2);
  g.position.copy(pos);
  scene.add(g);
  bombs.push({ g, vel: new THREE.Vector3(0, -2, 0), blink: 0 });
  sfx(700, 0.1, 'square', 0.05, 400);
}

function explode(pos) {
  // Fireball + shockwave of debris
  for (let i = 0; i < 30; i++) {
    const s = 0.3 + Math.random() * 0.5;
    const c = [0xff9d20, 0xffd24a, 0xd8443a][(Math.random() * 3) | 0];
    const m = new THREE.Mesh(box(s, s, s), mat(c));
    m.position.copy(pos);
    scene.add(m);
    bits.push({
      mesh: m, life: 0.6 + Math.random() * 0.6,
      vel: new THREE.Vector3((Math.random() - 0.5) * 26, Math.random() * 16 + 4, (Math.random() - 0.5) * 26),
    });
  }
  state.shake = Math.max(state.shake, 0.9);
  if (actx) {
    const t0 = actx.currentTime;
    const o = actx.createOscillator(), g2 = actx.createGain(), f = actx.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(160, t0);
    o.frequency.exponentialRampToValueAtTime(28, t0 + 0.65);
    f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t0);
    f.frequency.exponentialRampToValueAtTime(160, t0 + 0.6);
    g2.gain.setValueAtTime(0.28, t0);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
    o.connect(f); f.connect(g2); g2.connect(actx.destination);
    o.start(t0); o.stop(t0 + 0.78);
  }
  // Blast damages everything nearby - zombies AND the player
  const BLAST = 15;
  for (const z of zombies) {
    if (z.dead) continue;
    const d = z.group.position.distanceTo(pos);
    if (d < BLAST) {
      hitZombie(z, 8, z.group.position.clone().setY(2), true,
                z.group.position.clone().sub(pos).normalize().multiplyScalar(26).setY(18));
    }
  }
  for (const p of props) {
    if (p.held) continue;
    const d = p.mesh.position.distanceTo(pos);
    if (d < BLAST * 1.4) {
      p.vel.add(p.mesh.position.clone().sub(pos).normalize().multiplyScalar(30 - d));
      p.vel.y += 14;
      p.spin.set(6, 6, 6);
    }
  }
  if (truck.position.distanceTo(pos) < BLAST && !state.over) damage(22);
}

// ─────────────────────────────────────────────────────────────────────────────
// Particles (impact juice)
// ─────────────────────────────────────────────────────────────────────────────
const bits = [];
// Drop the oldest particles once over budget. Without a ceiling a mega-boss death
// during a heavy wave can spike thousands of meshes in a single frame.
function trimBits() {
  while (bits.length > MAX_BITS) { scene.remove(bits[0].mesh); bits.shift(); }
}
function burst(pos, color, count = 16, power = 9) {
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(UNIT_BOX, particleMat(color));
    m.scale.setScalar(0.32);
    m.position.copy(pos);
    scene.add(m);
    trimBits();
    bits.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * power,
        Math.random() * power * 0.9 + 2,
        (Math.random() - 0.5) * power
      ),
      life: 1.0 + Math.random() * 0.5,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio (WebAudio, no asset files needed)
// ─────────────────────────────────────────────────────────────────────────────
let actx = null;
function sfx(freq, dur, type = 'square', vol = 0.09, slideTo = null) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, actx.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, actx.currentTime + dur);
  g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(); o.stop(actx.currentTime + dur);
}

// Continuous hydraulic whine while the crane moves - a loader crane should sound
// mechanical, not silent. One persistent oscillator gated by a gain envelope so
// it can't stack into a screech when several axes move at once.
let hydOsc = null, hydGain = null, hydFilt = null, hydOn = false;
function setHydraulic(on) {
  if (!actx) return;
  if (!hydOsc) {
    hydOsc = actx.createOscillator(); hydGain = actx.createGain(); hydFilt = actx.createBiquadFilter();
    hydOsc.type = 'sawtooth';
    hydOsc.frequency.setValueAtTime(62, actx.currentTime);
    hydFilt.type = 'bandpass';
    hydFilt.frequency.setValueAtTime(430, actx.currentTime);
    hydFilt.Q.setValueAtTime(3.5, actx.currentTime);
    hydGain.gain.setValueAtTime(0.0001, actx.currentTime);
    hydOsc.connect(hydFilt); hydFilt.connect(hydGain); hydGain.connect(actx.destination);
    hydOsc.start();
  }
  if (on === hydOn) return;
  hydOn = on;
  const t = actx.currentTime;
  hydGain.gain.cancelScheduledValues(t);
  hydGain.gain.setValueAtTime(Math.max(hydGain.gain.value, 0.0001), t);
  hydGain.gain.exponentialRampToValueAtTime(on ? 0.045 : 0.0001, t + (on ? 0.06 : 0.18));
  if (on) hydOsc.frequency.setTargetAtTime(58 + Math.random() * 14, t, 0.2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Background music - procedural, no asset files. A dirty driving bassline with
// a detuned lead that gets busier and nastier as the wave count climbs, so the
// soundtrack tracks the pressure instead of looping the same clip forever.
// ─────────────────────────────────────────────────────────────────────────────
const music = { on: true, node: null, step: 0, next: 0, bus: null };

// Minor-key riff (semitones from root) - grimy, driving, horror-adjacent
const BASS_RIFF = [0, 0, 3, 0, 5, 0, 3, -2];
const LEAD_RIFF = [12, 15, 14, 12, 10, 12, 15, 17];
const ROOT = 55;                   // A1

function musicInit() {
  if (!actx || music.bus) return;
  music.bus = actx.createGain();
  music.bus.gain.value = 0.0001;
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 8;
  music.bus.connect(comp); comp.connect(actx.destination);
  music.bus.gain.exponentialRampToValueAtTime(0.5, actx.currentTime + 2.0);
}

function musicVoice(freq, dur, type, vol, filtHz, detune = 0) {
  const t0 = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain(), f = actx.createBiquadFilter();
  o.type = type; o.frequency.setValueAtTime(freq, t0); o.detune.setValueAtTime(detune, t0);
  f.type = 'lowpass'; f.frequency.setValueAtTime(filtHz, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(120, filtHz * 0.45), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(f); f.connect(g); g.connect(music.bus);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function musicDrum(kind) {
  const t0 = actx.currentTime;
  if (kind === 'kick') {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t0);
    o.frequency.exponentialRampToValueAtTime(42, t0 + 0.13);
    g.gain.setValueAtTime(0.55, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.19);
    o.connect(g); g.connect(music.bus); o.start(t0); o.stop(t0 + 0.2);
  } else {
    // noise burst hat/snare from a short buffer
    const len = Math.floor(actx.sampleRate * 0.09);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = actx.createBufferSource(); src.buffer = buf;
    const f = actx.createBiquadFilter();
    f.type = kind === 'snare' ? 'bandpass' : 'highpass';
    f.frequency.value = kind === 'snare' ? 1800 : 7000;
    const g = actx.createGain();
    g.gain.value = kind === 'snare' ? 0.3 : 0.12;
    src.connect(f); f.connect(g); g.connect(music.bus);
    src.start(t0);
  }
}

function musicTick() {
  if (!actx || !music.on || !music.bus || !state.started || state.over) return;
  const now = actx.currentTime;
  if (now < music.next) return;

  // tempo and grit rise with the wave
  const intensity = Math.min(1, (state.wave - 1) / 8);
  const stepDur = 0.30 - intensity * 0.08;
  music.next = (music.next || now) + stepDur;
  if (music.next < now) music.next = now + stepDur;

  const i = music.step % 8;
  const semi = BASS_RIFF[i];
  musicVoice(ROOT * Math.pow(2, semi / 12), stepDur * 1.5, 'sawtooth',
             0.16 + intensity * 0.07, 300 + intensity * 900);

  musicDrum(i % 4 === 0 ? 'kick' : (i % 4 === 2 ? 'snare' : 'hat'));

  // lead only kicks in once things get hairy, and detunes as it escalates
  if (state.wave >= 2 && (i % 2 === 0 || intensity > 0.5)) {
    const l = LEAD_RIFF[i];
    musicVoice(ROOT * Math.pow(2, l / 12), stepDur * 0.9, 'square',
               0.05 + intensity * 0.05, 1400 + intensity * 2200,
               (Math.random() - 0.5) * 26 * intensity);
  }
  // low drone under everything at high waves
  if (intensity > 0.6 && i === 0) {
    musicVoice(ROOT / 2, stepDur * 8, 'sawtooth', 0.07, 220);
  }
  music.step++;
}

function toggleMusic() {
  music.on = !music.on;
  if (music.bus && actx) {
    music.bus.gain.cancelScheduledValues(actx.currentTime);
    music.bus.gain.setValueAtTime(Math.max(music.bus.gain.value, 0.0001), actx.currentTime);
    music.bus.gain.exponentialRampToValueAtTime(music.on ? 0.5 : 0.0001, actx.currentTime + 0.4);
  }
  toast(music.on ? 'MUSIC ON' : 'MUSIC OFF');
}

// ─────────────────────────────────────────────────────────────────────────────
// Game state
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  started: false, over: false,
  tokens: 0, kills: 0, wave: 1, killsThisWave: 0, killsNeeded: 6,
  hp: 100, maxHp: 100, lastDamage: 99,
  spawnTimer: 2.0, shake: 0,
  truckVel: new THREE.Vector3(), truckSpeed: 0, heading: 0,
  // Knuckle boom state: slew (column yaw), inner boom lift, knuckle fold, telescope
  // Starts DEPLOYED (inner boom up, knuckle folded down-and-out) rather than
  // stowed flat along the deck - a stowed crane reads as broken at a glance.
  // Pre-solved IK pose for the starting tip target, so the crane already reads as
  // deployed on the title screen instead of settling from a stowed pose.
  slew: 0, lift: 1.21, knuckle: -1.96, tele: 0.45, jaw: 0,
  tipR: 16, tipH: 7,          // IK target: grapple tip reach + height
  // ASSIST (mouse/IK) is deliberately easy, so it's a limited resource. JOINT
  // mode - driving each hydraulic axis yourself, like a real crane - is the
  // default and recharges the assist meter.
  aimX: 0, aimY: 0.55, usingMouse: false, mouseAim: true,
  held: null,
};

const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if ([ 'Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight' ].includes(e.code)) e.preventDefault();
  if (e.code === 'Space') tryGrabRelease();
  if (e.code === 'KeyM') toggleMusic();
});
addEventListener('keyup', e => { keys[e.code] = false; });

// ── MOUSE flies the end effector: move = X (slew) + Y (height), wheel = Z (reach) ──
// Pointer lock so you can keep swinging past the edge of the screen.
// The grapple simply follows the mouse. Screen X = swing, screen Y = height.
// No pointer lock, no mode toggle, no fuel - one intuitive control.
addEventListener('mousemove', e => {
  if (!state.started || state.over || !state.mouseAim) return;
  state.aimX = (e.clientX / innerWidth) * 2 - 1;
  state.aimY = e.clientY / innerHeight;
  state.usingMouse = true;
});
addEventListener('wheel', e => {
  if (!state.started || state.over) return;
  state.tipR = THREE.MathUtils.clamp(state.tipR + Math.sign(e.deltaY) * 1.5, 7, 32);
  e.preventDefault();
}, { passive: false });
addEventListener('mousedown', e => {
  if (state.started && !state.over && e.button === 0) tryGrabRelease();
});

const el = {
  tokens: document.getElementById('tokens'),
  wave: document.getElementById('wave'),
  kills: document.getElementById('kills'),
  hpfill: document.getElementById('hpfill'),
  center: document.getElementById('center'),
  bigmsg: document.getElementById('bigmsg'),
  submsg: document.getElementById('submsg'),
  grabhint: document.getElementById('grabhint'),
  toast: document.getElementById('toast'),
};

function setHUD() {
  el.tokens.childNodes[1].nodeValue = state.tokens;
  el.wave.childNodes[1].nodeValue = state.wave;
  el.kills.childNodes[1].nodeValue = state.kills;
  el.hpfill.style.width = Math.max(0, (state.hp / state.maxHp) * 100) + '%';

  el.hpfill.style.background = state.hp > 50
    ? 'linear-gradient(90deg,#43e06a,#a8e063)'
    : state.hp > 25 ? 'linear-gradient(90deg,#e0c043,#e0a043)'
    : 'linear-gradient(90deg,#e04343,#e07043)';
}

let toastT = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.style.opacity = '1';
  toastT = 1.4;
}

function startGame() {
  if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)(); }
  if (!state.started) {
    state.started = true;
    el.center.style.display = 'none';
    musicInit();
  } else if (state.over) {
    location.reload();
  }
}
// The lobby decides when play begins (solo or after joining a room)
let lobbyDone = false;
addEventListener('click', () => { if (lobbyDone) startGame(); });
initLobby(() => { lobbyDone = true; startGame(); });
net.onJoined = m => {
  lobbyDone = true;
  if (m.spawn) { truck.position.set(m.spawn.x, 0, m.spawn.z); }
  startGame();
  toast(`ROOM ${m.room.code}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Grab / fling
// ─────────────────────────────────────────────────────────────────────────────
const hookWorld = new THREE.Vector3();
const prevHookWorld = new THREE.Vector3();
const hookVel = new THREE.Vector3();

function tryGrabRelease() {
  if (!state.started || state.over) return;
  if (state.held) {
    // FLING: the prop inherits the hook's swing velocity, amplified so a big
    // swing genuinely launches things (limp releases feel terrible).
    const p = state.held;
    if (p.group) {
      // Hurled zombie: dies on release and becomes a ragdoll projectile that
      // takes out whatever it lands on.
      p.grabbed = false;
      const throwVel = hookVel.clone().multiplyScalar(FLING_BOOST);
      throwVel.y += 6;
      killZombie(p, p.group.position.clone().setY(2), throwVel.length() > 14);
      p.launch = throwVel;
      p.isProjectile = true;
    } else {
      p.held = false;
      p.vel.copy(hookVel).multiplyScalar(FLING_BOOST);
      p.vel.y += 1.5;
      p.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    }
    state.held = null;
    sfx(320, 0.16, 'sawtooth', 0.10, 90);
    return;
  }
  let best = null, bestD = GRAB_RANGE;
  for (const p of props) {
    const d = p.mesh.position.distanceTo(hookWorld);
    if (d < bestD) { best = p; bestD = d; }
  }
  // Zombies are grabbable too - snatch one out of the horde and use it as a
  // flail, or hurl it into its friends. Bosses are too heavy to lift.
  for (const z of zombies) {
    if (z.dead || z.isBoss || z.grabbed) continue;
    const d = z.group.position.clone().setY(z.group.position.y + 2).distanceTo(hookWorld);
    if (d < bestD) { best = z; bestD = d; }
  }
  if (best) {
    if (best.group) {                     // it's a zombie
      best.grabbed = true;
      state.held = best;
      zombieGroan(false, best.voice);                 // it screams as it's lifted
    } else {
      best.held = true; best.vel.set(0, 0, 0); state.held = best;
    }
    sfx(180, 0.09, 'square', 0.08, 260);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
// ── Mobile: virtual sticks + buttons. Left stick drives, right stick flies the
// crane (slew/height in assist, boom/knuckle in manual). Detected by touch
// capability rather than screen size, so a touchscreen laptop works too.
const touch = { drive: { x: 0, y: 0 }, crane: { x: 0, y: 0 }, boost: false, reach: 0 };
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) {
  document.body.classList.add('touch');
  const bindStick = (id, out) => {
    const elS = document.getElementById(id);
    const nub = elS.querySelector('.nub');
    let active = null;
    const R = 46;
    const set = (dx, dy) => {
      const d = Math.hypot(dx, dy), k = d > R ? R / d : 1;
      const nx = dx * k, ny = dy * k;
      nub.style.transform = `translate(${nx}px, ${ny}px)`;
      out.x = nx / R; out.y = ny / R;
    };
    const reset = () => { nub.style.transform = 'translate(0,0)'; out.x = 0; out.y = 0; active = null; };
    elS.addEventListener('touchstart', e => {
      const t = e.changedTouches[0]; active = t.identifier;
      const r = elS.getBoundingClientRect();
      set(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2));
      e.preventDefault();
    }, { passive: false });
    elS.addEventListener('touchmove', e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== active) continue;
        const r = elS.getBoundingClientRect();
        set(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2));
      }
      e.preventDefault();
    }, { passive: false });
    const end = e => { for (const t of e.changedTouches) if (t.identifier === active) reset(); };
    elS.addEventListener('touchend', end);
    elS.addEventListener('touchcancel', end);
  };
  bindStick('stickL', touch.drive);
  bindStick('stickR', touch.crane);

  const bindBtn = (id, down, up) => {
    const b = document.getElementById(id);
    b.addEventListener('touchstart', e => { down(); e.preventDefault(); }, { passive: false });
    if (up) { b.addEventListener('touchend', up); b.addEventListener('touchcancel', up); }
  };
  bindBtn('btnGrab', () => { if (!state.started) { startGame(); return; } tryGrabRelease(); });
  bindBtn('btnBoost', () => { touch.boost = true; }, () => { touch.boost = false; });
  bindBtn('btnUp', () => { touch.reach = 1; }, () => { touch.reach = 0; });
  // tapping the canvas starts / restarts
  renderer.domElement.addEventListener('touchstart', () => {
    if (!state.started || state.over) startGame();
  });
}

// ── On-screen boom buttons: hold to move that axis. Mouse-aim still works;
// these give you an explicit control for every axis without memorising keys.
const btn = { up:0, down:0, left:0, right:0, extend:0, retract:0, rotL:0, rotR:0 };
for (const b of document.querySelectorAll('#boompad .bbtn')) {
  const act = b.dataset.act;
  const press = e => {
    e.preventDefault();
    if (act === 'grab') { if (!state.started) { startGame(); return; } tryGrabRelease(); return; }
    if (act === 'mouse') {
      state.mouseAim = !state.mouseAim;
      state.usingMouse = state.usingMouse && state.mouseAim;
      b.textContent = '';
      const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = '🖱';
      b.appendChild(ico);
      b.appendChild(document.createTextNode('MOUSE AIM: ' + (state.mouseAim ? 'ON' : 'OFF')));
      b.classList.toggle('off', !state.mouseAim);
      toast(state.mouseAim ? 'MOUSE AIM ON' : 'BUTTONS ONLY');
      sfx(state.mouseAim ? 660 : 300, 0.14, 'triangle', 0.07, state.mouseAim ? 900 : 180);
      return;
    }
    btn[act] = 1; b.classList.add('down');
    state.usingMouse = false;          // buttons take over from mouse-follow
  };
  const release = () => { if (act !== 'grab' && act !== 'mouse') { btn[act] = 0; b.classList.remove('down'); } };
  b.addEventListener('mousedown', press);
  b.addEventListener('touchstart', press, { passive: false });
  addEventListener('mouseup', release);
  b.addEventListener('touchend', release);
  b.addEventListener('touchcancel', release);
  b.addEventListener('mouseleave', release);
}

// ── Remote players: a simplified crane rig per connected player, lerped toward
// the last state the server relayed (20 Hz updates, smoothed on the client). ──
const remotes = new Map();
function makeRemoteTruck(color) {
  const g = new THREE.Group();
  const ch = new THREE.Mesh(box(4.4, 1.1, 14), mat(0x2a2f38));
  ch.position.y = 1.9; ch.castShadow = true; g.add(ch);
  const cb = new THREE.Mesh(box(4.4, 3.2, 4.4), mat(color));
  cb.position.set(0, 4.1, -4.8); cb.castShadow = true; g.add(cb);
  const win = new THREE.Mesh(box(4.0, 1.4, 0.2), mat(0x1d2b38));
  win.position.set(0, 4.8, -7.0); g.add(win);
  for (const [wx, wz] of [[-2.4, -5.0], [2.4, -5.0], [-2.4, 2.2], [2.4, 2.2], [-2.4, 4.8], [2.4, 4.8]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.95, 12), mat(0x141519));
    w.rotation.z = Math.PI / 2; w.position.set(wx, 1.3, wz); g.add(w);
  }
  const colG = new THREE.Group(); colG.position.set(0, 3.0, -1.4); g.add(colG);
  const col = new THREE.Mesh(box(2.3, 4.2, 2.3), mat(COL_YELLOW));
  col.position.y = 2.9; col.castShadow = true; colG.add(col);
  const inner = new THREE.Group(); inner.position.y = 5.0; colG.add(inner);
  const ib = new THREE.Mesh(box(1.4, 1.4, 11), mat(BOOM_NAVY));
  ib.position.z = 5.5; ib.castShadow = true; inner.add(ib);
  const kn = new THREE.Group(); kn.position.z = 11; inner.add(kn);
  const ob = new THREE.Mesh(box(1.15, 1.15, 10), mat(BOOM_NAVY));
  ob.position.z = 5; ob.castShadow = true; kn.add(ob);
  const gr = new THREE.Mesh(box(1.5, 1.2, 1.5), mat(0xc0392b));
  gr.position.z = 10.6; kn.add(gr);
  // name tag
  const tagCan = document.createElement('canvas');
  tagCan.width = 256; tagCan.height = 64;
  const tex = new THREE.CanvasTexture(tagCan);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(14, 3.5, 1); spr.position.set(0, 12, 0);
  g.add(spr);
  scene.add(g);
  return { g, colG, inner, kn, tagCan, tex, spr };
}

function updateRemotes(dt) {
  for (const [id, p] of net.players) {
    let r = remotes.get(id);
    if (!r) {
      r = makeRemoteTruck(p.color ?? 0x3bd8ff);
      const ctx = r.tagCan.getContext('2d');
      ctx.clearRect(0, 0, 256, 64);
      ctx.font = 'bold 34px Bungee, monospace';
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6;
      ctx.strokeText(p.name || '?', 128, 44);
      ctx.fillText(p.name || '?', 128, 44);
      r.tex.needsUpdate = true;
      remotes.set(id, r);
    }
    const k = Math.min(1, dt * 9);
    r.g.position.x += (p.x - r.g.position.x) * k;
    r.g.position.z += (p.z - r.g.position.z) * k;
    let dh = p.heading - r.g.rotation.y;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    r.g.rotation.y += dh * k;
    r.colG.rotation.y += ((p.slew || 0) - r.colG.rotation.y) * k;
    r.inner.rotation.x += (-(p.lift || 0) - r.inner.rotation.x) * k;
    r.kn.rotation.x += (-(p.knuckle || 0) - r.kn.rotation.x) * k;
    r.spr.position.set(0, 12, 0);
  }
  for (const [id, r] of remotes) {
    if (!net.players.has(id)) { scene.remove(r.g); remotes.delete(id); }
  }
}

const clock = new THREE.Clock();
const camPos = new THREE.Vector3(0, 26, -34);
const camLook = new THREE.Vector3();
const tmp = new THREE.Vector3();

function damage(amount) {
  if (!state.started) return;      // attract mode is invincible
  state.hp -= amount;
  state.lastDamage = 0;
  state.shake = Math.max(state.shake, 0.55);
  sfx(90, 0.18, 'square', 0.12, 50);
  if (state.hp <= 0 && !state.over) {
    state.hp = 0;
    state.over = true;
    el.center.style.display = 'flex';
    const logo = document.getElementById('logo');
    if (logo) logo.style.display = 'none';
    el.bigmsg.style.display = 'block';
    el.bigmsg.style.color = '#e0433f';
    el.bigmsg.textContent = 'TRUCK DESTROYED';
    el.submsg.innerHTML = `Wave ${state.wave} · ${state.kills} ${THEME.enemyWord.toLowerCase()}s flattened · <span class="key">CLICK TO RETRY</span>`;
  }
  setHUD();
}

// Per-type zombie voices - each variant sounds distinct so you can hear what's
// coming before you see it (shriek = punk, engine rev = biker, titan = boss).
const VOICES = {
  normal: { base: 112, drop: 0.45, dur: 0.6, warble: 13, cut: 760, wave: 'sawtooth', vol: 0.16 },
  deep:   { base: 62,  drop: 0.40, dur: 0.85, warble: 7,  cut: 420, wave: 'sawtooth', vol: 0.20 },
  shriek: { base: 320, drop: 1.9,  dur: 0.45, warble: 26, cut: 2600, wave: 'square',  vol: 0.12 },
  rev:    { base: 150, drop: 0.75, dur: 0.7, warble: 42, cut: 1100, wave: 'square',   vol: 0.15 },
  baa:      { base: 300, drop: 0.55, dur: 0.55, warble: 18, cut: 2200, wave: 'sawtooth', vol: 0.13 },
  baaHi:    { base: 430, drop: 0.6,  dur: 0.42, warble: 24, cut: 3000, wave: 'sawtooth', vol: 0.11 },
  baaLow:   { base: 170, drop: 0.5,  dur: 0.8,  warble: 12, cut: 1200, wave: 'sawtooth', vol: 0.16 },
  baaTitan: { base: 90,  drop: 0.42, dur: 1.4,  warble: 6,  cut: 620,  wave: 'sawtooth', vol: 0.26 },
  titan:  { base: 38,  drop: 0.35, dur: 1.5, warble: 4,  cut: 260, wave: 'sawtooth',  vol: 0.28 },
};
function zombieGroan(hard, voice = 'normal') {
  if (!actx) return;
  const v = VOICES[voice] || VOICES.normal;
  const t0 = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain(), lfo = actx.createOscillator(), lfoGain = actx.createGain();
  o.type = v.wave;
  const base = v.base * (0.9 + Math.random() * 0.25) * (hard ? 0.8 : 1);
  o.frequency.setValueAtTime(base, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(18, base * v.drop), t0 + v.dur * 0.9);
  lfo.frequency.setValueAtTime(v.warble * (0.8 + Math.random() * 0.5), t0);
  lfoGain.gain.setValueAtTime(v.base * 0.16, t0);
  lfo.connect(lfoGain); lfoGain.connect(o.frequency);
  const filt = actx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.setValueAtTime(v.cut, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v.vol, t0 + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
  o.connect(filt); filt.connect(g); g.connect(actx.destination);
  o.start(t0); lfo.start(t0);
  o.stop(t0 + v.dur + 0.05); lfo.stop(t0 + v.dur + 0.05);
}

// Per-material impact sounds so a shark, a barrel and a car all land differently
const IMPACT = {
  flesh:  { f: 120, to: 60,  dur: 0.17, wave: 'sine',     vol: 0.13 },
  metal:  { f: 620, to: 190, dur: 0.30, wave: 'square',   vol: 0.11 },
  wood:   { f: 260, to: 110, dur: 0.14, wave: 'triangle', vol: 0.12 },
  plastic:{ f: 420, to: 240, dur: 0.11, wave: 'triangle', vol: 0.09 },
  candy:  { f: 880, to: 520, dur: 0.13, wave: 'sine',     vol: 0.10 },
  glassy: { f: 1400, to: 700, dur: 0.16, wave: 'sine',    vol: 0.09 },
};
function impactSound(kind, strength = 1) {
  const s = IMPACT[kind] || IMPACT.wood;
  sfx(s.f * (0.9 + Math.random() * 0.2), s.dur, s.wave,
      Math.min(0.2, s.vol * strength), s.to);
}

// Chunky cubes of blood - the Carmageddon-style gore
function bloodSpray(pos, amount, power) {
  amount = Math.round(amount * THEME.goreCount);
  for (let i = 0; i < amount; i++) {
    const s = 0.18 + Math.random() * 0.34;
    const m = new THREE.Mesh(UNIT_BOX, particleMat(THEME.gore[(Math.random() * THEME.gore.length) | 0]));
    m.scale.setScalar(s);
    m.position.copy(pos);
    m.position.x += (Math.random() - 0.5) * 1.2;
    m.position.z += (Math.random() - 0.5) * 1.2;
    scene.add(m);
    bits.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * power,
        Math.random() * power * 0.85 + 3,
        (Math.random() - 0.5) * power
      ),
      life: 2.2 + Math.random() * 1.6,
      sticky: true,       // blood settles and stains instead of vanishing mid-air
    });
  }
  trimBits();
}

// Damage a zombie; only kill it when HP actually runs out. Boom sweeps, rams and
// blasts all route through here - previously they called killZombie() directly,
// which one-shot the BOSS and made every tanky type meaningless.
function hitZombie(z, dmg, pos, hard, launchVec) {
  if (z.dead) return false;
  z.hp -= dmg;
  z.hitFlash = 0.12;
  if (z.hp <= 0) {
    killZombie(z, pos, hard);
    if (launchVec) z.launch = launchVec;
    return true;
  }
  // survived - spray a little blood, stagger it back, and grunt
  bloodSpray(pos, Math.min(10, 3 + dmg * 2), 7);
  if (launchVec) {
    z.group.position.addScaledVector(launchVec.clone().normalize(), 2.2);
  }
  zombieGroan(false, z.voice);
  state.shake = Math.max(state.shake, 0.15);
  return false;
}

function killZombie(z, pos, hard) {
  if (z.dead) return;
  z.dead = true; z.deadT = 0;
  state.kills++; state.tokens++; state.killsThisWave++;
  bloodSpray(pos, hard ? 34 : 20, hard ? 15 : 10);
  burst(pos, 0x7ab04f, hard ? 10 : 6, hard ? 11 : 7);
  state.shake = Math.max(state.shake, hard ? 0.5 : 0.28);
  zombieGroan(hard, z.voice);
  sfx(hard ? 150 : 220, 0.12, 'square', 0.07, 60);
  sendKill(state.wave);
  if (state.killsThisWave >= state.killsNeeded) {
    state.wave++;
    state.killsThisWave = 0;
    state.killsNeeded = Math.round(state.killsNeeded * 1.45);
    toast(`WAVE ${state.wave}`);
    sfx(440, 0.5, 'triangle', 0.09, 880);
  }
  setHUD();
}

// Chase camera. Runs on the title screen too - skipping it left the camera at the
// world origin (i.e. buried in the ground), which made the title screen look broken.
function updateCamera(dt, idle) {
  const heading = idle ? state.heading + performance.now() * 0.00012 : state.heading;
  const back = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
  // Camera rises and pulls back as the grapple goes up, so rooftop loot is
  // actually visible - a fixed low chase cam hid everything above ground level.
  const lift = THREE.MathUtils.clamp((hookWorld.y - 8) / 22, 0, 1);
  const dist = (idle ? 34 : 30) + lift * 20;
  const high = (idle ? 15 : 19) + lift * 26;
  camPos.copy(truck.position).addScaledVector(back, dist).add(new THREE.Vector3(0, high, 0));
  camera.position.lerp(camPos, 1 - Math.pow(0.0016, dt));
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dt * 1.9);
    camera.position.x += (Math.random() - 0.5) * state.shake * 2.4;
    camera.position.y += (Math.random() - 0.5) * state.shake * 2.4;
  }
  // Bias the look-at toward the grapple when it's raised, so the tip stays framed
  camLook.copy(truck.position).add(new THREE.Vector3(0, 3.5, 0));
  if (!idle && hookWorld.y > 10) camLook.lerp(hookWorld, THREE.MathUtils.clamp((hookWorld.y - 10) / 20, 0, 0.45));
  camera.lookAt(camLook);
}

function tick() {
  if (glLost) return;                 // dead context: stop, the overlay has the message
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  // ATTRACT MODE: before the player starts, the game plays ITSELF behind the
  // lobby - the truck cruises, the boom swings, zombies spawn and get splattered.
  // Same simulation, synthetic inputs, damage disabled so it can never "die".
  const attract = !state.started;

  // ── Truck driving ──
  if (!state.over) {
    const boost = (keys['ShiftLeft'] || keys['ShiftRight'] || touch.boost) ? 1.75 : 1.0;
    let accel = (keys['KeyW'] ? 26 : 0) - (keys['KeyZ'] || keys['KeyS'] ? 18 : 0);
    if (attract) accel = 21;
    if (touch.drive.y < -0.15) accel += -touch.drive.y * 26;
    if (touch.drive.y > 0.15) accel -= touch.drive.y * 18;
    state.truckSpeed += accel * boost * dt;
    state.truckSpeed *= 0.965;                       // drag
    state.truckSpeed = THREE.MathUtils.clamp(state.truckSpeed, -18, 34 * boost);

    const turnRate = 1.9 * THREE.MathUtils.clamp(Math.abs(state.truckSpeed) / 9, 0, 1);
    let steer = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);
    if (attract) steer = Math.sin(performance.now() * 0.00021) * 0.95;
    if (Math.abs(touch.drive.x) > 0.15) steer -= touch.drive.x;
    state.heading += steer * turnRate * dt * Math.sign(state.truckSpeed || 1);
    truck.rotation.y = state.heading;

    const fwd = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
    truck.position.addScaledVector(fwd, state.truckSpeed * dt);
    truck.position.x = THREE.MathUtils.clamp(truck.position.x, -ARENA + 6, ARENA - 6);
    truck.position.z = THREE.MathUtils.clamp(truck.position.z, -ARENA + 6, ARENA - 6);

    // ── Obstacle collision: push the truck out, kill momentum on hard hits ──
    const TRUCK_R = 5.0;
    for (const o of obstacles) {
      const dx = truck.position.x - o.x, dz = truck.position.z - o.z;
      const dsq = dx * dx + dz * dz;
      const minD = o.r + TRUCK_R;
      if (dsq < minD * minD && dsq > 1e-6) {
        const dd = Math.sqrt(dsq);
        const push = (minD - dd);
        truck.position.x += (dx / dd) * push;
        truck.position.z += (dz / dd) * push;
        if (o.hard) {
          if (Math.abs(state.truckSpeed) > 16) {      // real crunch
            state.shake = Math.max(state.shake, 0.45);
            sfx(110, 0.16, 'square', 0.10, 55);
            burst(truck.position.clone().setY(3), 0xb0b6bd, 10, 7);
          }
          state.truckSpeed *= 0.12;                    // walls stop you
        } else {
          state.truckSpeed *= 0.82;                    // trees just slow you down
        }
      }
    }
    // Ally trucks are solid too
    for (const a of allies) {
      const dx = truck.position.x - a.g.position.x, dz = truck.position.z - a.g.position.z;
      const dsq = dx * dx + dz * dz;
      const minD = 9.0;
      if (dsq < minD * minD && dsq > 1e-6) {
        const dd = Math.sqrt(dsq);
        truck.position.x += (dx / dd) * (minD - dd);
        truck.position.z += (dz / dd) * (minD - dd);
        state.truckSpeed *= 0.35;
      }
    }

    for (const w of wheels) w.rotation.x += state.truckSpeed * dt * 1.1;

    // ── Crane control: you steer the GRAPPLE TIP in X/Y/Z, and 2-link inverse
    // kinematics solves the boom + knuckle angles to reach it. This is how a real
    // proportional crane remote feels (move the tool, not each joint) and it's
    // what makes the crane usable as a weapon instead of a puzzle.
    // Right-hand cluster flies the grapple like a drone: H/K left-right,
    // U/N up-down, J/L in-out. The telescope extends itself to match reach.
    if (attract) {
      const at = performance.now() * 0.001;
      state.slew   += Math.sin(at * 0.62) * 1.5 * dt;
      state.tipH    = 13 + Math.sin(at * 0.85) * 8;
      state.tipR    = 19 + Math.cos(at * 0.47) * 9;
      state.attractGrab = (state.attractGrab ?? 2) - dt;
      if (state.attractGrab <= 0) { state.attractGrab = 1.6 + Math.random() * 2.2; tryGrabRelease(); }
    }

    // ── ONE control scheme: the grapple goes where you point ──
    if (state.usingMouse && !attract) {
      const wantSlew = state.heading - state.aimX * 1.15;        // screen X -> swing
      let dS = wantSlew - state.slew;
      while (dS > Math.PI) dS -= Math.PI * 2;
      while (dS < -Math.PI) dS += Math.PI * 2;
      state.slew += dS * Math.min(1, dt * 5);
      const wantH = THREE.MathUtils.lerp(26, 3, state.aimY);     // screen Y -> height
      state.tipH += (wantH - state.tipH) * Math.min(1, dt * 5);
    }
    // Button panel (and the arrow keys) drive each axis explicitly
    if (btn.rotL)    state.slew += 1.6 * dt;
    if (btn.rotR)    state.slew -= 1.6 * dt;
    if (btn.up)      state.tipH = Math.min(state.tipH + 13 * dt, 30);
    if (btn.down)    state.tipH = Math.max(state.tipH - 13 * dt, 2.6);
    if (btn.left)    state.slew += 1.6 * dt;
    if (btn.right)   state.slew -= 1.6 * dt;
    if (btn.extend)  state.tipR = Math.min(state.tipR + 12 * dt, 32);
    if (btn.retract) state.tipR = Math.max(state.tipR - 12 * dt, 7);
    if (keys['ArrowLeft'])  state.slew += 1.6 * dt;
    if (keys['ArrowRight']) state.slew -= 1.6 * dt;
    if (keys['ArrowUp'])    state.tipH = Math.min(state.tipH + 13 * dt, 30);
    if (keys['ArrowDown'])  state.tipH = Math.max(state.tipH - 13 * dt, 2.6);
    if (Math.abs(touch.crane.x) > 0.12) state.slew -= touch.crane.x * 1.6 * dt;
    if (Math.abs(touch.crane.y) > 0.12)
      state.tipH = THREE.MathUtils.clamp(state.tipH - touch.crane.y * 14 * dt, 2.6, 30);
    if (touch.reach) state.tipR = Math.min(state.tipR + 11 * dt, 32);

    craneColumn.rotation.y = state.slew;

    state.tele += (THREE.MathUtils.clamp((state.tipR - 11) / 19, 0, 1) - state.tele) * Math.min(1, dt * 4);
    const reach = state.tele * 13;
    teleSections.forEach((sec, i) => {
      sec.position.z = OUTER_LEN * 0.75 + reach * ((i + 1) / teleSections.length);
    });
    grappleAnchor.position.z = OUTER_LEN * 0.75 + reach + 3.2;

    // ── 2-link IK (law of cosines) ──
    const L1 = INNER_LEN;
    const L2 = OUTER_LEN * 0.75 + reach + 3.2;
    const COLUMN_TOP = 8.0;                       // world height of the inner-boom pivot
    const dy = state.tipH - COLUMN_TOP;
    const dx = state.tipR;
    let d = Math.hypot(dx, dy);
    d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 0.6, L1 + L2 - 0.6);   // stay reachable
    const phi = Math.atan2(dy, dx);
    const a = Math.acos(THREE.MathUtils.clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1));
    const b = Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const liftAngle = phi + a;                    // inner boom above horizontal
    const foldAngle = Math.PI - b;                // how far the knuckle folds down

    // Only the assist mode drives the joints from IK; in joint mode the player's
    // own axis inputs above are authoritative and IK is just kept in sync.
    state.lift += (liftAngle - state.lift) * Math.min(1, dt * 8);
    state.knuckle += (-foldAngle - state.knuckle) * Math.min(1, dt * 8);
    innerPivot.rotation.x = -state.lift;
    knucklePivot.rotation.x = -state.knuckle;
  }

  // Grapple jaws open/close visibly with grab state
  state.jaw += ((state.held ? 0.15 : 1.0) - state.jaw) * Math.min(1, dt * 9);
  for (const j of jaws) j.pivot.rotation.z = j.dir * state.jaw * 0.55;

  // Hydraulic whine while any crane axis is moving
  const craneMoving = !state.over && (state.usingMouse || keys['ArrowLeft'] || keys['ArrowRight'] ||
                                      keys['ArrowUp'] || keys['ArrowDown'] || touch.crane.x || touch.crane.y ||
                                      btn.up || btn.down || btn.left || btn.right ||
                                      btn.extend || btn.retract || btn.rotL || btn.rotR);
  setHydraulic(craneMoving);

  // ── Grapple world position + swing velocity (this is what makes flinging work) ──
  prevHookWorld.copy(hookWorld);
  grappleAnchor.getWorldPosition(hookWorld);
  // A real crane tip cannot pass through the ground - clamp it (and back the
  // knuckle off) instead of letting the grapple sink into the dirt.
  const GRAPPLE_FLOOR = 2.4;
  if (hookWorld.y < GRAPPLE_FLOOR) {
    hookWorld.y = GRAPPLE_FLOOR;
    if (!state.over) state.knuckle = Math.min(state.knuckle + 1.6 * dt, 0.35);
  }
  hookVel.subVectors(hookWorld, prevHookWorld).divideScalar(Math.max(dt, 1e-4));
  grapple.position.copy(hookWorld);
  grapple.rotation.y = state.slew + state.heading;

  const cablePts = cable.geometry.attributes.position;
  knucklePivot.getWorldPosition(tmp);
  cablePts.setXYZ(0, tmp.x, tmp.y, tmp.z);
  cablePts.setXYZ(1, hookWorld.x, hookWorld.y, hookWorld.z);
  cablePts.needsUpdate = true;

  // ── BOOM SWEEP: swinging the crane through a zombie splatters it ──
  const boomSweepSpeed = hookVel.length();
  if (boomSweepSpeed > 6 && !state.over) {
    for (const z of zombies) {
      if (z.dead) continue;
      if (z.group.position.distanceTo(hookWorld) < 4.2) {
        // Faster swings hit harder - a big slow boss needs several good hits
        const dmg = Math.max(1, Math.round(boomSweepSpeed / 7));
        hitZombie(z, dmg, z.group.position.clone().setY(2), boomSweepSpeed > 16,
                  hookVel.clone().multiplyScalar(0.55));
      }
    }
  }

  // ── Grab hint ──
  if (!state.held) {
    let near = false;
    for (const p of props) if (p.mesh.position.distanceTo(hookWorld) < GRAB_RANGE) { near = true; break; }
    el.grabhint.textContent = 'SPACE — GRAB';
    el.grabhint.style.opacity = near ? '1' : '0';
  } else {
    el.grabhint.textContent = 'SPACE — FLING';
    el.grabhint.style.opacity = '1';
  }

  // ── Props physics ──
  for (const p of props) {
    if (p.held) {
      p.mesh.position.lerp(hookWorld, 0.55);
      p.mesh.rotation.x *= 0.9; p.mesh.rotation.z *= 0.9;
      continue;
    }
    p.vel.y -= 26 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.rotation.x += p.spin.x * dt;
    p.mesh.rotation.y += p.spin.y * dt;
    p.mesh.rotation.z += p.spin.z * dt;

    // Rooftop props rest on their roof until they're knocked clear of it
    let floorY = p.r * 0.55;
    if (p.restY !== undefined) {
      const rt = p.roof || (p.roof = rooftops.find(r =>
        Math.abs(p.mesh.position.x - r.x) < r.w / 2 && Math.abs(p.mesh.position.z - r.z) < r.d / 2));
      if (rt && Math.abs(p.mesh.position.x - rt.x) < rt.w / 2 && Math.abs(p.mesh.position.z - rt.z) < rt.d / 2) {
        floorY = p.restY;
      } else {
        p.restY = undefined; p.roof = null;      // pushed off the edge - falls to the ground
      }
    }
    if (p.mesh.position.y < floorY) {
      p.mesh.position.y = floorY;
      if (Math.abs(p.vel.y) > 3) {
        p.vel.y *= -0.32;                        // bounce
        burst(p.mesh.position, 0xbdb08a, 5, 4);
        impactSound(p.snd, Math.min(1.6, Math.abs(p.vel.y) / 12));
      } else p.vel.y = 0;
      p.vel.x *= 0.86; p.vel.z *= 0.86;
      p.spin.multiplyScalar(0.86);
    }
    for (const axis of ['x', 'z']) {
      if (p.mesh.position[axis] < -ARENA + 3) { p.mesh.position[axis] = -ARENA + 3; p.vel[axis] *= -0.4; }
      if (p.mesh.position[axis] > ARENA - 3) { p.mesh.position[axis] = ARENA - 3; p.vel[axis] *= -0.4; }
    }
  }

  // ── Zombie spawning ──
  if (!state.over) {
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      const interval = Math.max(0.55, 2.6 - state.wave * 0.22);
      state.spawnTimer = interval;
      const cap = Math.min(6 + state.wave * 3, 40);
      if (zombies.filter(z => !z.dead).length < cap) spawnZombie();
    }
  }

  // ── Zombies ──
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.dead) {
      z.deadT += dt;
      if (z.launch) {                     // punted by a boom sweep or big hit
        z.group.position.addScaledVector(z.launch, dt);
        z.launch.y -= 30 * dt;
        z.launch.multiplyScalar(0.98);
        z.group.rotation.z += dt * 7;
        if (z.group.position.y <= 0) { z.group.position.y = 0; z.launch = null; }
      }
      z.group.rotation.x = Math.min(z.deadT * 5, Math.PI / 2);
      if (!z.launch) z.group.position.y = Math.max(0, z.group.position.y - 3 * dt);
      if (z.deadT > 2.2) {
        z.group.scale.multiplyScalar(0.86);
        if (z.deadT > 3.4) { scene.remove(z.group); zombies.splice(i, 1); }
      }
      continue;
    }

    tmp.subVectors(truck.position, z.group.position); tmp.y = 0;
    const dist = tmp.length();
    tmp.normalize();
    z.group.position.addScaledVector(tmp, z.speed * dt);
    z.group.rotation.y = Math.atan2(tmp.x, tmp.z);

    // shamble animation
    z.walk += dt * (z.speed * 1.5);
    const sw = Math.sin(z.walk) * 0.55;
    z.legL.rotation.x = sw; z.legR.rotation.x = -sw;
    z.group.position.y = Math.abs(Math.sin(z.walk * 2)) * 0.16;

    // Hit by a flung prop?
    for (const p of props) {
      if (p.held) continue;
      const sp = p.vel.length();
      if (sp < ZOMBIE_KILL_SPEED) continue;
      if (p.mesh.position.distanceTo(z.group.position) < p.r + 1.6) {
        impactSound(p.snd, Math.min(1.8, sp / 14));
        hitZombie(z, Math.ceil(sp / 8), z.group.position.clone().setY(2), sp > 20,
                  p.vel.clone().multiplyScalar(0.6));
        p.vel.multiplyScalar(0.55);
        break;
      }
    }
    if (z.dead) continue;

    // Truck contact
    if (dist < 5.4) {
      const speed = Math.abs(state.truckSpeed);
      if (speed > TRUCK_RAM_SPEED) {
        const fwd2 = new THREE.Vector3(Math.sin(state.heading), 0.35, Math.cos(state.heading));
        hitZombie(z, Math.max(1, Math.round(speed / 6)), z.group.position.clone().setY(2),
                  speed > 20, fwd2.multiplyScalar(speed * 0.7));
      } else if (state.lastDamage > 0.65 && !state.over) {
        damage(z.scale > 1.2 ? 9 : 5);
      }
    }
  }
  state.lastDamage += dt;

  // ── Repair when not taking damage (rest-to-repair from the design) ──
  if (!state.over && state.lastDamage > 6 && state.hp < state.maxHp) {
    state.hp = Math.min(state.maxHp, state.hp + 5 * dt);
    setHUD();
  }

  // ── Particles ──
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    b.vel.y -= 24 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    if (b.mesh.position.y < 0.16) {
      b.mesh.position.y = 0.16;
      if (b.sticky) { b.vel.set(0, 0, 0); }      // blood splats and stays put
      else { b.vel.y *= -0.34; b.vel.x *= 0.7; b.vel.z *= 0.7; }
    }
    b.life -= dt;
    if (!b.sticky || b.vel.lengthSq() > 0.01) { b.mesh.rotation.x += dt * 8; b.mesh.rotation.y += dt * 6; }
    if (b.life <= 0) { scene.remove(b.mesh); bits.splice(i, 1); }
  }

  // ── Zombie trucks: hunt the player, ram, and can be wrecked by the crane ──
  if (!state.over && state.wave >= 3) {
    state.zTruckTimer = (state.zTruckTimer ?? 14) - dt;
    if (state.zTruckTimer <= 0) {
      state.zTruckTimer = Math.max(12, 34 - state.wave * 2);
      if (zTrucks.length < Math.min(1 + Math.floor(state.wave / 3), 4)) spawnZombieTruck();
    }
  }
  for (let i = zTrucks.length - 1; i >= 0; i--) {
    const zt = zTrucks[i];
    tmp.subVectors(truck.position, zt.g.position); tmp.y = 0;
    const dz = tmp.length(); tmp.normalize();
    zt.g.position.addScaledVector(tmp, zt.speed * dt);
    const want = Math.atan2(tmp.x, tmp.z);
    let dh = want - zt.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    zt.heading += dh * Math.min(1, dt * 2.4);
    zt.g.rotation.y = zt.heading;

    zt.hitCd -= dt;
    if (dz < 8.5 && zt.hitCd <= 0 && !state.over) {
      zt.hitCd = 1.3;
      damage(14);
      burst(zt.g.position.clone().setY(3), 0xb8bcc2, 14, 9);
      state.truckSpeed *= -0.4;                       // knocked back
      sfx(95, 0.25, 'square', 0.13, 45);
    }

    // the grapple and flung props wreck it
    if (zt.g.position.distanceTo(hookWorld) < 7 && hookVel.length() > 6) zt.hp -= 3;
    for (const p of props) {
      if (p.held) continue;
      if (p.vel.length() > 11 && p.mesh.position.distanceTo(zt.g.position.clone().setY(3)) < p.r + 4.5) {
        zt.hp -= 4; p.vel.multiplyScalar(0.4);
      }
    }
    if (zt.hp <= 0) {
      explode(zt.g.position.clone().setY(2.5));
      scene.remove(zt.g); zTrucks.splice(i, 1);
      state.tokens += 8; state.kills++; setHUD();
      toast('TRUCK WRECKED  +8');
    }
  }

  // ── Bomber drones ──
  if (!state.over && state.wave >= 2) {
    state.droneTimer = (state.droneTimer ?? 8) - dt;
    if (state.droneTimer <= 0) {
      state.droneTimer = Math.max(6, 20 - state.wave * 1.6);
      if (drones.length < Math.min(1 + Math.floor(state.wave / 2), 6)) spawnDrone();
    }
  }
  for (let i = drones.length - 1; i >= 0; i--) {
    const dr = drones[i];
    dr.bob += dt * 2.4;
    for (const r of dr.rotors) r.rotation.y += dt * 42;

    // hover toward a point above the truck
    tmp.subVectors(truck.position, dr.g.position); tmp.y = 0;
    const hd = tmp.length(); tmp.normalize();
    if (hd > 8) dr.g.position.addScaledVector(tmp, 17 * dt);
    dr.g.position.y += ((30 + Math.sin(dr.bob) * 2.5) - dr.g.position.y) * Math.min(1, dt * 1.6);
    dr.g.rotation.y = Math.atan2(tmp.x, tmp.z);
    dr.g.rotation.z = Math.sin(dr.bob * 1.3) * 0.09;

    // drop a bomb when roughly overhead
    dr.cooldown -= dt;
    if (dr.cooldown <= 0 && hd < 26 && !state.over) {
      dr.cooldown = 3.4 + Math.random() * 2;
      dropBomb(dr.g.position.clone().setY(dr.g.position.y - 1.2));
    }

    // Kamikaze: a damaged drone dives at the truck and detonates on contact
    if (dr.diving) {
      const dv = truck.position.clone().setY(3).sub(dr.g.position).normalize();
      dr.g.position.addScaledVector(dv, 46 * dt);
      dr.g.rotation.z += dt * 9;
      if (dr.g.position.distanceTo(truck.position.clone().setY(3)) < 6) {
        explode(dr.g.position.clone());
        scene.remove(dr.g); drones.splice(i, 1);
        continue;
      }
    }

    // Anything flung into a drone knocks it out of the sky
    for (const p of props) {
      if (p.held) continue;
      if (p.vel.length() > 9 && p.mesh.position.distanceTo(dr.g.position) < p.r + 3.2) {
        dr.hp -= 2; p.vel.multiplyScalar(0.4);
        break;
      }
    }

    // the grapple can swat a drone out of the sky
    if (dr.g.position.distanceTo(hookWorld) < 5.5 && hookVel.length() > 5) dr.hp -= 2;

    if (dr.hp <= 0 && !dr.diving) {
      // Losing a rotor sends it into a burning dive rather than just vanishing
      dr.diving = true;
      burst(dr.g.position.clone(), 0xff9d20, 12, 8);
      toast('DRONE HIT');
      state.tokens += 3; setHUD();
      sfx(420, 0.5, 'sawtooth', 0.10, 60);
    }
  }

  // ── Bombs ──
  for (let i = bombs.length - 1; i >= 0; i--) {
    const bm = bombs[i];
    bm.vel.y -= 22 * dt;
    bm.g.position.addScaledVector(bm.vel, dt);
    bm.g.rotation.x += dt * 1.5;
    bm.blink += dt;
    if (Math.floor(bm.blink * 9) % 2 === 0) bm.g.children[1].material.color.setHex(0xff2a1f);
    else bm.g.children[1].material.color.setHex(0x7a1a14);
    if (bm.g.position.y <= 1.0) {
      explode(bm.g.position.clone().setY(1.2));
      scene.remove(bm.g); bombs.splice(i, 1);
    }
  }

  // ── Towers: perched zombies lob arrows/vomit, then leap down at you ──
  for (const tw of towers) {
    if (state.over || tw.occupants <= 0) continue;
    const distT = Math.hypot(truck.position.x - tw.x, truck.position.z - tw.z);
    if (distT > 110) continue;
    tw.cooldown -= dt;
    if (tw.cooldown <= 0) {
      tw.cooldown = 2.2 + Math.random() * 2.2;
      const from = new THREE.Vector3(tw.x + (Math.random() - 0.5) * 6, tw.top, tw.z + (Math.random() - 0.5) * 6);
      towerProjectile(from, truck.position.clone().setY(3), Math.random() < 0.55 ? 'arrow' : 'vomit');
    }
    tw.leapT -= dt;
    if (tw.leapT <= 0 && distT < 60) {          // a zombie throws itself off the tower
      tw.leapT = 9 + Math.random() * 9;
      tw.occupants--;
      const parts = makeZombie(0);
      parts.group.position.set(tw.x, tw.top, tw.z);
      scene.add(parts.group);
      const zz = {
        ...parts, vel: new THREE.Vector3(), speed: ZOMBIE_TYPES[0].speed, hp: ZOMBIE_TYPES[0].hp,
        maxHp: ZOMBIE_TYPES[0].hp, dead: false, deadT: 0, walk: 0, scale: 1,
        isBoss: false, launch: null, voice: 'shriek', falling: true,
        fallVel: new THREE.Vector3((truck.position.x - tw.x) * 0.05, 4, (truck.position.z - tw.z) * 0.05),
      };
      zombies.push(zz);
      zombieGroan(false, 'shriek');
    }
  }

  // Falling tower-jumpers
  for (const z of zombies) {
    if (!z.falling || z.dead) continue;
    z.fallVel.y -= 26 * dt;
    z.group.position.addScaledVector(z.fallVel, dt);
    z.group.rotation.z += dt * 6;
    if (z.group.position.y <= 0) {
      z.group.position.y = 0; z.group.rotation.z = 0; z.falling = false;
      burst(z.group.position.clone().setY(1), 0x8a7a5a, 8, 6);
      state.shake = Math.max(state.shake, 0.12);
    }
  }

  // ── Tower projectiles ──
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.vel.y -= 26 * dt;
    pr.g.position.addScaledVector(pr.vel, dt);
    if (pr.kind === 'arrow') pr.g.rotation.set(Math.atan2(-pr.vel.y, Math.hypot(pr.vel.x, pr.vel.z)), Math.atan2(pr.vel.x, pr.vel.z), 0);
    else pr.g.rotation.x += dt * 5;
    pr.life -= dt;
    const hitTruck = pr.g.position.distanceTo(truck.position.clone().setY(3)) < 5.5;
    if (hitTruck && !state.over) {
      damage(pr.kind === 'arrow' ? 7 : 11);
      burst(pr.g.position.clone(), pr.kind === 'arrow' ? 0xb8bcc2 : 0x8fbf3a, 10, 6);
      scene.remove(pr.g); projectiles.splice(i, 1); continue;
    }
    if (pr.g.position.y <= 0.4 || pr.life <= 0) {
      if (pr.kind === 'vomit') burst(pr.g.position.clone().setY(0.4), 0x8fbf3a, 8, 5);
      scene.remove(pr.g); projectiles.splice(i, 1);
    }
  }

  // ── Buildings catch fire over time, then burn ──
  if (!state.over) {
    state.fireTimer = (state.fireTimer ?? 30) - dt;
    if (state.fireTimer <= 0) {
      state.fireTimer = 34 + Math.random() * 26;
      const candidates = rooftops.filter(r => !r.burning);
      if (candidates.length) igniteBuilding(candidates[(Math.random() * candidates.length) | 0]);
    }
  }
  for (const f of fires) {
    f.t += dt;
    for (const fl of f.flames) {
      const ph = fl.userData.phase + f.t * 7;
      fl.scale.set(0.7 + Math.sin(ph) * 0.35, 1 + Math.sin(ph * 1.4) * 0.5, 0.7 + Math.cos(ph) * 0.35);
      fl.position.y = fl.userData.baseY + Math.sin(ph * 0.9) * 0.7;
      fl.material.opacity = 0.65 + Math.sin(ph * 2) * 0.3;
    }
    if (f.smoke) {
      f.smoke.position.y = f.rt.top + 10 + Math.sin(f.t * 0.8) * 1.5;
      f.smoke.rotation.y += dt * 0.3;
      f.smoke.scale.setScalar(1 + Math.sin(f.t * 0.5) * 0.15);
    }
    // fire burns anything too close
    if (!state.over && Math.hypot(truck.position.x - f.rt.x, truck.position.z - f.rt.z) < Math.max(f.rt.w, f.rt.d) * 0.6 + 6
        && state.lastDamage > 1.0) {
      damage(6);
    }
    for (const z of zombies) {
      if (z.dead) continue;
      if (Math.hypot(z.group.position.x - f.rt.x, z.group.position.z - f.rt.z) < Math.max(f.rt.w, f.rt.d) * 0.55) {
        hitZombie(z, 2, z.group.position.clone().setY(2), false, null);
      }
    }
  }

  // ── Water: wave the lake surface + shimmer the glints ──
  const t = performance.now() * 0.001;
  const lp = lakeGeo.attributes.position;
  for (let i = 0; i < lp.count; i++) {
    const bx = lakeBase[i * 3], by = lakeBase[i * 3 + 1];
    lp.setZ(i, Math.sin(bx * 0.14 + t * 1.6) * 0.55 + Math.cos(by * 0.17 + t * 1.15) * 0.45);
  }
  lp.needsUpdate = true;
  lakeGeo.computeVertexNormals();
  for (const gl of glints) {
    gl.material.opacity = 0.28 + Math.abs(Math.sin(t * 2.2 + gl.userData.phase)) * 0.6;
    gl.position.y = 0.3 + Math.sin(t * 1.8 + gl.userData.phase) * 0.18;
  }

  // ── Birds: circle, bob, flap ──
  for (const b of birds) {
    b.ang += b.speed * dt;
    b.flap += dt * 11;
    b.bob += dt * 1.4;
    b.g.position.set(
      b.cx + Math.cos(b.ang) * b.radius,
      b.y + Math.sin(b.bob) * 2.2,
      b.cz + Math.sin(b.ang) * b.radius
    );
    b.g.rotation.y = -b.ang + Math.PI / 2;
    const f = Math.sin(b.flap) * 0.7;
    b.wingL.rotation.z = f; b.wingR.rotation.z = -f;
  }

  // ── Allies: drive near one and it joins in, flinging junk at zombies ──
  for (const a of allies) {
    const d = a.g.position.distanceTo(truck.position);
    if (!a.active && d < 26) {
      a.active = true;
      toast('ALLY CRANE JOINED');
      sfx(520, 0.18, 'triangle', 0.09, 780);
    }
    if (!a.active) continue;

    // swing its boom for show
    a.armPivot.rotation.y = Math.sin(t * 1.3) * 0.9;

    // follow the player at a distance
    tmp.subVectors(truck.position, a.g.position); tmp.y = 0;
    const dist = tmp.length(); tmp.normalize();
    if (dist > 30) a.g.position.addScaledVector(tmp, 13 * dt);
    a.g.rotation.y = Math.atan2(tmp.x, tmp.z);

    // ── Ally actually GRAPPLES: picks a prop up, swings it, then hurls it ──
    const allyGrapWorld = new THREE.Vector3();
    a.grapA.getWorldPosition(allyGrapWorld);

    if (a.carrying) {
      // hold the prop in the grapple while the boom swings around
      a.carryT -= dt;
      a.carrying.mesh.position.lerp(allyGrapWorld, 0.5);
      a.carrying.vel.set(0, 0, 0);
      if (a.carryT <= 0) {
        let target = null, td = 90;
        for (const z of zombies) {
          if (z.dead) continue;
          const zd = z.group.position.distanceTo(a.g.position);
          if (zd < td) { target = z; td = zd; }
        }
        const ammo = a.carrying;
        ammo.held = false;
        if (target) {
          const aim = new THREE.Vector3().subVectors(target.group.position, ammo.mesh.position);
          const flight = Math.max(0.6, aim.length() / 34);
          ammo.vel.copy(aim).divideScalar(flight);
          ammo.vel.y += 13 * flight;
        } else {
          ammo.vel.set((Math.random() - 0.5) * 20, 12, (Math.random() - 0.5) * 20);
        }
        ammo.spin.set(4, 3, 5);
        impactSound(ammo.snd, 1.1);
        a.carrying = null;
        a.cooldown = 2.6 + Math.random();
      }
    } else {
      a.cooldown -= dt;
      if (a.cooldown <= 0) {
        let ammo = null, ad = 40;
        for (const p of props) {
          if (p.held || p.restY !== undefined) continue;
          const pd = p.mesh.position.distanceTo(a.g.position);
          if (pd < ad) { ammo = p; ad = pd; }
        }
        if (ammo) {
          ammo.held = true;              // reserved by the ally's grapple
          a.carrying = ammo;
          a.carryT = 0.9;
          sfx(200, 0.1, 'square', 0.05, 300);
        } else {
          a.cooldown = 1.2;
        }
      }
    }
  }

  updateRemotes(dt);
  sendState({
    x: truck.position.x, z: truck.position.z, heading: state.heading,
    slew: state.slew, lift: state.lift, knuckle: state.knuckle, tele: state.tele, hp: state.hp,
  });
  if (net.room) {
    const nb = document.getElementById('netbar');
    if (nb) {
      nb.style.display = 'block';
      nb.innerHTML = `ROOM <span class="code">${net.room.code}</span><br>${net.room.count} CRANES${net.isHost ? ' · HOST' : ''}`;
    }
  }

  musicTick();
  setHUD();

  // ── Toast fade ──
  if (toastT > 0) {
    toastT -= dt;
    el.toast.style.opacity = String(Math.max(0, Math.min(1, toastT / 0.5)));
  }

  updateCamera(dt, attract);
  renderer.render(scene, camera);
}

// Place the camera correctly on frame 0 so the very first rendered frame is a
// proper view of the truck, not a lerp starting from the world origin.
camera.position.set(0, 19, -30);
camera.lookAt(truck.position.clone().add(new THREE.Vector3(0, 3.5, 0)));

// ── Apply edition branding (one build, two skins) ──
(function applyEdition() {
  document.documentElement.style.setProperty('--accent', THEME.accentColor);
  document.querySelectorAll('#logo .zed, #lobbyLogo .zed').forEach(zed => {
    zed.firstChild && (zed.firstChild.nodeValue = THEME.accent);
    zed.style.color = THEME.accentColor;
    zed.style.webkitTextStroke = `5px ${THEME.accentStroke}`;
    if (THEME.edition === 'S') {
      zed.querySelectorAll('.drip').forEach(d => d.remove());   // no blood in the sheep cut
      zed.style.textShadow = '0 5px 0 #9a9aa6, 0 10px 0 #6e6e7a, 0 0 30px rgba(255,255,255,.45), 0 16px 30px rgba(0,0,0,.9)';
    }
  });
  document.querySelectorAll('#logo .sub, #lobbyLogo .sub').forEach(sub => {
    sub.textContent = THEME.tagline;
  });
  const tokLabel = document.querySelector('#tokens span');
  if (tokLabel) tokLabel.textContent = THEME.tokenWord;
  document.title = `CRANEFORMER${THEME.accent}`;
})();

setHUD();
tick();
