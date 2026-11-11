import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createPaper, fold, flip, rotate, makeLine, bisectorLine, sideOf, reflectPoint,
  poseFaces, creasePattern, snapPoints, bounds, cloneState, LAYER_GAP, isFrontUp,
} from './paper.js';
import { PRESETS, applyOp } from './presets.js';
import { buildModel, FoldSim } from './sim.js';
import { Bgm } from './bgm.js';

// ================================================================ 状態

const PAPER_SHAPES = {
  square: [2, 2],
  a4: [2 / Math.SQRT2, 2],
  strip: [1, 2],
};

const ui = {
  input: 'line',      // 'line' | 'point'
  type: 'valley',     // 'valley' | 'mountain'
  mode: 'all',        // 'all' | 'component'
  orbit: false,
  speed: 1,
  frontColor: '#e2463f',
  backColor: '#fbf8f1',
  pattern: 'plain',
  shape: 'square',
};

let state = createPaper(...PAPER_SHAPES[ui.shape]);
let undoStack = [];
let redoStack = [];
let busy = false;
let dirty = true;
let currentStep = -1; // 再生中などに強調する手順
// 鶴のように展開図からシミュレーションで折る見本を表示しているとき
// { preset, model, sim, frames: [{ p, pos }], q (0..1 表示中の折り具合), full }
let simMode = null;

// 入力の状態
const input = {
  phase: 'idle',   // 'idle' | 'drawing' | 'choose'
  start: null,
  end: null,
  line: null,
  hover: null,
  downAt: null,
  pointers: new Set(),
  shift: false,
};

// ================================================================ three.js

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
camera.up.set(0, 0, 1);
camera.position.set(0, -3.4, 4.4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 1.2;
controls.maxDistance = 14;
controls.enablePan = true;
setOrbitButtons();

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cbb8, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-2.5, -3, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 20;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.16, depthWrite: false }),
);
ground.receiveShadow = true;
ground.position.z = -0.02;
scene.add(ground);

// 紙
const paperGeom = new THREE.BufferGeometry();
const frontMat = new THREE.MeshStandardMaterial({
  side: THREE.FrontSide, roughness: 0.85, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const backMat = new THREE.MeshStandardMaterial({
  side: THREE.BackSide, roughness: 0.9, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const frontMesh = new THREE.Mesh(paperGeom, frontMat);
const backMesh = new THREE.Mesh(paperGeom, backMat);
frontMesh.castShadow = backMesh.castShadow = true;
frontMesh.receiveShadow = backMesh.receiveShadow = true;
scene.add(frontMesh, backMesh);

const edgeGeom = new THREE.BufferGeometry();
const edges = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({
  color: 0x3a2a20, transparent: true, opacity: 0.35,
}));
scene.add(edges);

// シミュレーション用のメッシュ（鶴など）
const simGeom = new THREE.BufferGeometry();
const simFront = new THREE.Mesh(simGeom, frontMat);
const simBack = new THREE.Mesh(simGeom, backMat);
simFront.castShadow = simBack.castShadow = true;
simFront.receiveShadow = simBack.receiveShadow = true;
const simEdgeGeom = new THREE.BufferGeometry();
const simEdges = new THREE.LineSegments(simEdgeGeom, edges.material);
const simGroup = new THREE.Group();
simGroup.add(simFront, simBack, simEdges);
simGroup.visible = false;
scene.add(simGroup);

// 折り線のプレビュー
const previewGroup = new THREE.Group();
scene.add(previewGroup);
const highlightMat = new THREE.MeshBasicMaterial({
  color: 0xffc94a, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthTest: false,
});
const landingMat = new THREE.LineDashedMaterial({
  color: 0x2b2622, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.8, depthTest: false,
});
const foldLineMat = new THREE.MeshBasicMaterial({ color: 0x2f6fd6, transparent: true, opacity: 0.9, depthTest: false });
const pointMat = new THREE.MeshBasicMaterial({ color: 0x2b2622, depthTest: false });
const snapMat = new THREE.MeshBasicMaterial({ color: 0x2f6fd6, transparent: true, opacity: 0.85, depthTest: false });
const snapRing = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 32), snapMat);
snapRing.renderOrder = 20;
snapRing.visible = false;
scene.add(snapRing);

// ================================================================ 紙の模様

function makeTexture(color, pattern, isFront) {
  const [w, h] = [state.width, state.height];
  const W = 1024;
  const H = Math.round(W * h / w);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);

  // 和紙のような細かいムラ
  const img = g.getImageData(0, 0, W, H);
  let seed = isFront ? 7 : 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  if (isFront && pattern !== 'plain') {
    const light = shade(color, 0.35);
    const dark = shade(color, -0.25);
    g.lineWidth = 3;
    if (pattern === 'grid') {
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      const n = 8;
      for (let i = 1; i < n; i++) {
        g.beginPath(); g.moveTo((W * i) / n, 0); g.lineTo((W * i) / n, H); g.stroke();
      }
      const m = Math.round(n * h / w);
      for (let i = 1; i < m; i++) {
        g.beginPath(); g.moveTo(0, (H * i) / m); g.lineTo(W, (H * i) / m); g.stroke();
      }
    } else if (pattern === 'wave') {
      const r = 64;
      g.lineWidth = 4;
      for (let row = -1, y = H + r; y > -r; row++, y -= r / 2) {
        const off = (row % 2) * r;
        for (let x = -r + off; x < W + 2 * r; x += 2 * r) {
          for (let k = 4; k >= 1; k--) {
            g.beginPath();
            g.arc(x, y, (r * k) / 4, Math.PI, 2 * Math.PI);
            g.fillStyle = k % 2 ? color : dark;
            g.fill();
            g.strokeStyle = light;
            g.stroke();
          }
        }
      }
    } else if (pattern === 'dots') {
      g.fillStyle = light;
      const s = 96;
      for (let y = s / 2, row = 0; y < H + s; y += s / 2, row++) {
        for (let x = (row % 2) * (s / 2); x < W + s; x += s) {
          g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const t = amt > 0 ? 255 : 0;
    return Math.round(v + (t - v) * Math.abs(amt));
  });
  return `rgb(${ch.join(',')})`;
}

function updateTextures() {
  frontMat.map?.dispose();
  backMat.map?.dispose();
  frontMat.map = makeTexture(ui.frontColor, ui.pattern, true);
  backMat.map = makeTexture(ui.backColor, 'plain', false);
  frontMat.needsUpdate = backMat.needsUpdate = true;
  dirty = true;
}

// ================================================================ ジオメトリ更新

let lastPoseMinZ = 0;

function rebuildGeometry() {
  if (simMode) { rebuildSimGeometry(); return; }
  const posed = poseFaces(state);
  const pos = [];
  const uv = [];
  const ep = [];
  const w = state.width;
  const h = state.height;
  let minZ = Infinity;
  for (const { face, pts } of posed) {
    const vs = face.verts;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const j of [0, i, i + 1]) {
        pos.push(...pts[j]);
        uv.push((vs[j].u + w / 2) / w, (vs[j].v + h / 2) / h);
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      ep.push(...a, ...b);
      minZ = Math.min(minZ, a[2]);
    }
  }
  paperGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  paperGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  paperGeom.deleteAttribute('normal'); // 頂点数が変わるので作り直す
  paperGeom.computeVertexNormals();
  paperGeom.computeBoundingSphere();
  edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  edgeGeom.computeBoundingSphere();
  lastPoseMinZ = minZ;
  ground.position.z = Math.min(0, minZ) - 0.02;
}

// ================================================================ シミュレーションで折る見本（鶴）

function simPositions(q) {
  const { frames, full } = simMode;
  const p = q * full;
  let i = 1;
  while (i < frames.length - 1 && frames[i].p < p) i++;
  const a = frames[i - 1];
  const b = frames[i] ?? a;
  const t = b.p > a.p ? Math.min(1, Math.max(0, (p - a.p) / (b.p - a.p))) : 1;
  const out = new Float32Array(a.pos.length);
  for (let k = 0; k < out.length; k++) out[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * t;
  return out;
}

function rebuildSimGeometry() {
  const { model } = simMode;
  const P = simPositions(simMode.q);
  const pos = [];
  let minZ = Infinity;
  for (const t of model.tris) {
    for (const v of t) {
      pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
      minZ = Math.min(minZ, P[3 * v + 2]);
    }
  }
  simGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  simGeom.deleteAttribute('normal');
  simGeom.computeVertexNormals();
  simGeom.computeBoundingSphere();
  const ep = [];
  for (const [i, j] of model.creaseLines) ep.push(P[3 * i], P[3 * i + 1], P[3 * i + 2], P[3 * j], P[3 * j + 1], P[3 * j + 2]);
  simEdgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  simEdgeGeom.computeBoundingSphere();
  ground.position.z = Math.min(0, minZ) - 0.02;
}

async function enterSim(preset) {
  const { CRANE_CP } = await import('./data/crane-cp.js');
  const model = buildModel(CRANE_CP, 2);
  const sim = new FoldSim(model);
  simMode = { preset, model, sim, frames: [{ p: 0, pos: Float32Array.from(sim.pos) }], q: 0, full: 0.99 };
  const uv = [];
  for (const t of model.tris) for (const v of t) uv.push((model.uv[v][0] + 1) / 2, (model.uv[v][1] + 1) / 2);
  simGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  frontMesh.visible = backMesh.visible = edges.visible = false;
  simGroup.visible = true;
  dirty = true;
  renderSteps();
  drawCreasePattern();
}

function exitSim() {
  if (!simMode) return;
  simMode = null;
  frontMesh.visible = backMesh.visible = edges.visible = true;
  simGroup.visible = false;
  dirty = true;
}

// 物理シミュレーションを進めながら折る（途中の形を記録して、あとでスライダーで見られるようにする）
function runSimFold() {
  return new Promise((resolve) => {
    const { sim, frames, full } = simMode;
    const N = Math.round(240 / ui.speed);
    const settle = 40;
    let f = 0;
    const tick = () => {
      if (!simMode) { resolve(); return; }
      f++;
      const p = Math.min(1, f / N) * full;
      sim.percent = p;
      sim.step(120);
      const last = frames[frames.length - 1];
      const rec = { p, pos: Float32Array.from(sim.pos) };
      if (last.p === p) frames[frames.length - 1] = rec; else frames.push(rec);
      simMode.q = p / full;
      dirty = true;
      syncStepSliders();
      if (f < N + settle) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function animateSim(to, baseDuration = 2500) {
  const from = simMode.q;
  if (from === to) return Promise.resolve();
  const duration = (baseDuration * Math.max(0.3, Math.abs(to - from))) / ui.speed;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      if (!simMode) { resolve(); return; }
      const t = Math.min(1, (now - t0) / duration);
      simMode.q = from + (to - from) * easeInOut(t);
      dirty = true;
      syncStepSliders();
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function simBlocked() {
  if (!simMode) return false;
  toast(`「${simMode.preset.name}」の見本を表示中です。「リセット」で新しい紙に戻ります`);
  return true;
}

// ================================================================ アニメーション

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 複数の手順の角度を同時に変える
function animateAngles(targets, baseDuration = 700) {
  const entries = Object.entries(targets)
    .map(([i, to]) => ({ i: +i, from: state.steps[+i].angle, to }))
    .filter((e) => e.from !== e.to);
  if (entries.length === 0) return Promise.resolve();
  const maxDelta = Math.max(...entries.map((e) => Math.abs(e.to - e.from)));
  const duration = (baseDuration * Math.max(0.35, maxDelta / 180)) / ui.speed;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = easeInOut(t);
      for (const e of entries) state.steps[e.i].angle = e.from + (e.to - e.from) * k;
      dirty = true;
      syncStepSliders();
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function fullAngle(step) {
  return step.kind === 'rotate' ? step.full : 180;
}

async function runBusy(fn) {
  if (busy) return;
  busy = true;
  cancelInput();
  updateButtons();
  try {
    await fn();
  } finally {
    busy = false;
    currentStep = -1;
    updateButtons();
    renderSteps();
    updateHint();
  }
}

// 部分的に開いている手順があれば、折りたたんでから次の操作を行う
async function flattenAll() {
  const targets = {};
  state.steps.forEach((s, i) => { if (s.angle !== fullAngle(s)) targets[i] = fullAngle(s); });
  if (Object.keys(targets).length) {
    toast('開いている手順をたたみました');
    await animateAngles(targets, 500);
  }
}

// 新しい状態（最後の手順が追加されたもの）へアニメーションしながら進む
async function commit(result, targetAngle) {
  if (result.error) { toast(result.error); return false; }
  undoStack.push(cloneState(state));
  redoStack = [];
  const prevSteps = state.steps;
  state = result.state;
  // 既存の手順の角度は引き継ぐ
  prevSteps.forEach((s, i) => { state.steps[i].angle = s.angle; });
  const idx = state.steps.length - 1;
  const step = state.steps[idx];
  const goal = targetAngle ?? fullAngle(step);
  step.angle = 0;
  currentStep = idx;
  dirty = true;
  renderSteps();
  drawCreasePattern();
  await animateAngles({ [idx]: goal });
  recenter();
  return true;
}

// ================================================================ 操作

function doFold(line, side, pick) {
  if (simBlocked()) return;
  return runBusy(async () => {
    await flattenAll();
    const r = fold(state, {
      line, side, type: ui.type, mode: ui.mode,
      pick: pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' },
    });
    await commit(r);
  });
}

function doFlip() {
  if (simBlocked()) return;
  return runBusy(async () => { await flattenAll(); await commit(flip(state)); });
}

function doRotate() {
  if (simBlocked()) return;
  return runBusy(async () => { await flattenAll(); await commit(rotate(state, 90)); });
}

function undo() {
  if (simMode && !busy) {
    exitSim();
    renderSteps();
    drawCreasePattern();
    recenter();
    updateButtons();
    updateHint();
    return;
  }
  if (!undoStack.length) return;
  runBusy(async () => {
    const idx = state.steps.length - 1;
    if (idx >= 0) await animateAngles({ [idx]: 0 });
    redoStack.push(cloneState(state));
    // 元に戻した時の角度は今の角度を引き継ぐ
    const angles = state.steps.map((s) => s.angle);
    state = undoStack.pop();
    state.steps.forEach((s, i) => { if (angles[i] !== undefined) s.angle = angles[i]; });
    dirty = true;
    drawCreasePattern();
    recenter();
  });
}

function redo() {
  if (!redoStack.length || simMode) return;
  runBusy(async () => {
    const next = redoStack.pop();
    undoStack.push(cloneState(state));
    const idx = next.steps.length - 1;
    const goal = next.steps[idx]?.angle ?? 180;
    state.steps.forEach((s, i) => { next.steps[i].angle = s.angle; });
    state = next;
    if (idx >= 0) {
      state.steps[idx].angle = 0;
      currentStep = idx;
      renderSteps();
      await animateAngles({ [idx]: goal });
    }
    dirty = true;
    drawCreasePattern();
    recenter();
  });
}

function reset(shape = ui.shape) {
  if (busy) return;
  if (state.steps.length) undoStack.push(cloneState(state));
  redoStack = [];
  exitSim();
  ui.shape = shape;
  state = createPaper(...PAPER_SHAPES[shape]);
  updateTextures();
  dirty = true;
  cancelInput();
  renderSteps();
  drawCreasePattern();
  recenter(true);
  updateButtons();
}

function replay() {
  if (simMode) {
    runBusy(async () => { await animateSim(0, 900); await wait(250); await animateSim(1, 4000); });
    return;
  }
  if (!state.steps.length) return;
  runBusy(async () => {
    const targets = state.steps.map((s) => (s.angle > 0 ? s.angle : fullAngle(s)));
    const all = {};
    state.steps.forEach((s, i) => { all[i] = 0; });
    await animateAngles(all, 600);
    await wait(250);
    for (let i = 0; i < state.steps.length; i++) {
      currentStep = i;
      renderSteps();
      await animateAngles({ [i]: targets[i] });
      await wait(120 / ui.speed);
    }
  });
}

function setAllAngles(open) {
  if (simMode) { runBusy(() => animateSim(open ? 0 : 1)); return; }
  runBusy(async () => {
    const t = {};
    state.steps.forEach((s, i) => { t[i] = open ? 0 : fullAngle(s); });
    await animateAngles(t, 900);
  });
}

// i 番目の手順まで折った状態を見せる
function goToStep(i) {
  if (simMode) return;
  runBusy(async () => {
    const t = {};
    state.steps.forEach((s, j) => { t[j] = j <= i ? fullAngle(s) : 0; });
    currentStep = i;
    renderSteps();
    await animateAngles(t, 700);
  });
}

function playPreset(preset) {
  if (busy) return;
  if (ui.shape !== 'square') {
    document.getElementById('paper-shape').value = 'square';
  }
  reset('square');
  if (preset.kind === 'sim') {
    runBusy(async () => {
      await enterSim(preset);
      if (preset.credit) toast(preset.credit);
      await runSimFold();
      recenter();
      if (preset.view) moveCamera(preset.view);
    });
    return;
  }
  runBusy(async () => {
    await wait(200);
    for (const op of preset.steps) {
      const ok = await commit(applyOp(state, op));
      if (!ok) break;
      state.steps[state.steps.length - 1].caption = op.caption;
      renderSteps();
      await wait(150 / ui.speed);
    }
    const t = {};
    preset.steps.forEach((op, i) => { if (op.angle !== undefined && state.steps[i]) t[i] = op.angle; });
    await animateAngles(t, 900);
    if (preset.view) moveCamera(preset.view);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ 入力（折り線を引く）

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function viewFromBelow() {
  return camera.position.z < controls.target.z;
}

function pointerToPaper(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, p)) return null;
  return { x: p.x, y: p.y };
}

function snapRadius() {
  return 0.022 * camera.position.distanceTo(controls.target);
}

let snapCache = null;
function getSnapPoints() {
  if (!snapCache || snapCache.state !== state) snapCache = { state, pts: snapPoints(state) };
  return snapCache.pts;
}

function snap(pt) {
  if (!pt) return { pt, snapped: false };
  const r = snapRadius();
  let best = null;
  let bd = r;
  for (const s of getSnapPoints()) {
    const d = Math.hypot(s.x - pt.x, s.y - pt.y);
    // 頂点を優先
    const dd = s.kind === 'vertex' ? d * 0.7 : d;
    if (dd < bd) { bd = dd; best = s; }
  }
  return best ? { pt: { x: best.x, y: best.y }, snapped: true } : { pt, snapped: false };
}

function snapAngle(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 8;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len };
}

function anyPartial() {
  return state.steps.some((s) => s.angle !== fullAngle(s));
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  input.pointers.add(ev.pointerId);
  if (input.pointers.size > 1) { // 2 本指は視点操作
    if (input.phase === 'drawing') cancelInput();
    return;
  }
  if (busy || ui.orbit) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) {
    if (ev.button === 2 && input.phase === 'choose') cancelInput();
    return;
  }
  if (simBlocked()) return;
  if (anyPartial()) {
    toast('開いている手順があります。「たたむ」で折りたたんでから折ってください');
    return;
  }
  const raw = pointerToPaper(ev);
  if (!raw) return;
  input.downAt = { x: ev.clientX, y: ev.clientY, raw, phase: input.phase };
  const { pt } = snap(raw);
  if (input.phase !== 'choose') {
    input.phase = 'drawing';
    input.start = pt;
    input.end = pt;
  }
  canvas.setPointerCapture(ev.pointerId);
  updatePreview();
});

canvas.addEventListener('pointermove', (ev) => {
  if (busy || ui.orbit) { snapRing.visible = false; return; }
  const raw = pointerToPaper(ev);
  if (!raw) return;
  input.shift = ev.shiftKey;

  if (input.phase === 'choose' && input.downAt && moved(ev)) {
    // 選択中に新しくドラッグを始めたら、引き直し
    input.phase = 'drawing';
    input.start = snap(input.downAt.raw).pt;
  }

  if (input.phase === 'drawing') {
    let { pt, snapped } = snap(raw);
    if (input.shift && ui.input === 'line') { pt = snapAngle(input.start, raw); snapped = false; }
    input.end = pt;
    showSnap(snapped ? pt : null);
  } else if (input.phase === 'choose') {
    input.hover = raw;
    showSnap(null);
  } else {
    const { pt, snapped } = snap(raw);
    showSnap(snapped ? pt : null);
  }
  updatePreview();
});

function moved(ev) {
  const d = input.downAt;
  return d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6;
}

function endPointer(ev) {
  input.pointers.delete(ev.pointerId);
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
}

canvas.addEventListener('pointerup', (ev) => {
  const wasDown = input.downAt;
  const isClick = wasDown && !moved(ev);
  endPointer(ev);
  input.downAt = null;
  if (busy || !wasDown) return;

  if (input.phase === 'drawing') {
    const len = input.start && input.end ? Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y) : 0;
    if (len < 0.03) {
      cancelInput();
      if (wasDown.phase !== 'choose') updateHint('紙の上をドラッグして折り線を引いてください');
      return;
    }
    if (ui.input === 'point') {
      const line = bisectorLine(input.start, input.end);
      const side = Math.sign(sideOf(line, input.start));
      const pick = { ...input.start };
      // 点の少し内側を選ぶ（角そのものだと境界になるため）
      const toward = { x: line.p.x - pick.x, y: line.p.y - pick.y };
      const tl = Math.hypot(toward.x, toward.y) || 1;
      pick.x += (toward.x / tl) * 0.01; pick.y += (toward.y / tl) * 0.01;
      cancelInput();
      doFold(line, side, pick);
    } else {
      input.line = makeLine(input.start, input.end);
      input.phase = 'choose';
      input.hover = pointerToPaper(ev);
      updatePreview();
      updateHint();
    }
    return;
  }

  if (input.phase === 'choose' && isClick) {
    const pt = pointerToPaper(ev);
    if (!pt) return;
    const side = Math.sign(sideOf(input.line, pt));
    const line = input.line;
    cancelInput();
    doFold(line, side, pt);
  }
});

canvas.addEventListener('pointercancel', (ev) => { endPointer(ev); input.downAt = null; });
canvas.addEventListener('pointerleave', () => { snapRing.visible = false; });

function cancelInput() {
  input.phase = 'idle';
  input.start = input.end = input.line = input.hover = null;
  clearPreview();
  snapRing.visible = false;
  updateHint();
}

function showSnap(pt) {
  if (!pt) { snapRing.visible = false; return; }
  snapRing.visible = true;
  snapRing.position.set(pt.x, pt.y, topZ() + 0.003);
  const s = snapRadius() / 0.05 * 0.6;
  snapRing.scale.setScalar(Math.max(0.5, s));
}

function topZ() {
  const maxL = Math.max(0, ...state.faces.map((f) => f.layer));
  return maxL * LAYER_GAP + 0.004;
}

// ================================================================ プレビュー

function clearPreview() {
  for (const c of [...previewGroup.children]) {
    previewGroup.remove(c);
    c.geometry?.dispose();
  }
}

function lineQuad(a, b, width, z, mat) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * width / 2;
  const ny = (dx / len) * width / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x + nx, a.y + ny, z, a.x - nx, a.y - ny, z, b.x - nx, b.y - ny, z,
    a.x + nx, a.y + ny, z, b.x - nx, b.y - ny, z, b.x + nx, b.y + ny, z,
  ], 3));
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 15;
  return m;
}

function dot(p, z, r) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), pointMat);
  m.position.set(p.x, p.y, z);
  m.renderOrder = 16;
  return m;
}

function updatePreview() {
  clearPreview();
  const z = topZ() + 0.002;
  const w = 0.012 * camera.position.distanceTo(controls.target) / 5.5;

  let line = null;
  let side = 0;
  let pick = null;
  if (input.phase === 'drawing' && input.start && input.end) {
    if (ui.input === 'point') {
      line = bisectorLine(input.start, input.end);
      if (line) { side = Math.sign(sideOf(line, input.start)); pick = input.start; }
      // 動かす点から重ねる点への矢印
      previewGroup.add(lineQuad(input.start, input.end, w * 0.6, z + 0.001, pointMat));
      previewGroup.add(dot(input.start, z + 0.002, w * 1.6));
      previewGroup.add(dot(input.end, z + 0.002, w * 1.6));
    } else {
      line = makeLine(input.start, input.end);
      previewGroup.add(dot(input.start, z + 0.002, w * 1.4));
      previewGroup.add(dot(input.end, z + 0.002, w * 1.4));
    }
  } else if (input.phase === 'choose' && input.line) {
    line = input.line;
    if (input.hover) { side = Math.sign(sideOf(line, input.hover)); pick = input.hover; }
  }
  if (!line) return;

  // 折り線（長く伸ばして表示）
  const L = 6;
  const a = { x: line.p.x - line.d.x * L, y: line.p.y - line.d.y * L };
  const b = { x: line.p.x + line.d.x * L, y: line.p.y + line.d.y * L };
  foldLineMat.color.set(ui.type === 'valley' ? 0x2f6fd6 : 0xd2392b);
  previewGroup.add(lineQuad(a, b, w, z, foldLineMat));

  if (!side) return;
  // 動く部分の強調表示と、折った後の位置（点線）
  const r = fold(state, {
    line, side, type: ui.type, mode: ui.mode,
    pick: pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' },
  });
  if (r.error) return;
  const idx = r.state.steps.length - 1;
  for (const f of r.state.faces) {
    if (!f.moves.includes(idx)) continue;
    const orig = f.verts.map((v) => reflectPoint(line, v));
    const pos = [];
    for (let i = 1; i < orig.length - 1; i++) {
      for (const j of [0, i, i + 1]) pos.push(orig[j].x, orig[j].y, z - 0.001);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, highlightMat);
    m.renderOrder = 14;
    previewGroup.add(m);

    const lp = [];
    for (let i = 0; i < f.verts.length; i++) {
      const p = f.verts[i];
      const q = f.verts[(i + 1) % f.verts.length];
      lp.push(p.x, p.y, z, q.x, q.y, z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const ls = new THREE.LineSegments(lg, landingMat);
    ls.computeLineDistances();
    ls.renderOrder = 15;
    previewGroup.add(ls);
  }
}

// ================================================================ カメラ

let targetGoal = new THREE.Vector3();

function recenter(immediate = false) {
  if (simMode) {
    simGeom.computeBoundingBox();
    const box = simGeom.boundingBox;
    if (box) box.getCenter(targetGoal);
    return;
  }
  const b = bounds(state);
  targetGoal.set(b.cx, b.cy, 0);
  if (immediate) {
    const d = targetGoal.clone().sub(controls.target);
    controls.target.add(d);
    camera.position.add(d);
  }
}

function setView(kind) {
  const dist = camera.position.distanceTo(controls.target);
  let dir;
  if (kind === 'top') dir = new THREE.Vector3(0, -0.0001, 1);
  else if (kind === 'side') dir = new THREE.Vector3(0, -1, 0.12);
  else dir = new THREE.Vector3(0, -0.61, 0.79);
  moveCamera(dir.normalize().multiplyScalar(dist).toArray());
}

// 注視点からの相対位置 offset へカメラを動かす
function moveCamera(offset) {
  const t = controls.target.clone();
  const dist = new THREE.Vector3(...offset).length();
  const goal = t.clone().add(new THREE.Vector3(...offset));
  const from = camera.position.clone();
  const d0 = from.distanceTo(t);
  const t0 = performance.now();
  const tick = (now) => {
    const k = easeInOut(Math.min(1, (now - t0) / 600));
    camera.position.lerpVectors(from, goal, k);
    // 円弧に沿うように距離をなめらかに変える
    camera.position.sub(controls.target).setLength(d0 + (dist - d0) * k).add(controls.target);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setOrbitButtons() {
  controls.mouseButtons = {
    LEFT: ui.orbit ? THREE.MOUSE.ROTATE : null,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: ui.orbit ? THREE.TOUCH.ROTATE : null,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
  };
  canvas.classList.toggle('orbit', ui.orbit);
}

// ================================================================ UI

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function updateHint(msg) {
  const el = $('hint');
  if (msg) { el.textContent = msg; return; }
  if (busy) { el.textContent = ''; return; }
  if (ui.orbit) { el.textContent = 'ドラッグで視点を回転中（「⟲ 視点」で折るモードに戻ります）'; return; }
  if (simMode) { el.textContent = '右ドラッグ（2 本指）で回して見てみよう。スライダーで折り具合を変えられます'; return; }
  if (input.phase === 'choose') {
    el.textContent = ui.mode === 'component'
      ? '折りたい部分をクリック（Esc で取り消し）'
      : '折りたい側をクリック（Esc で取り消し）';
    return;
  }
  if (ui.input === 'point') {
    el.textContent = '動かしたい点を、重ねたい点までドラッグ';
  } else {
    el.textContent = state.steps.length === 0
      ? '紙の上をドラッグして折り線を引こう'
      : 'ドラッグで折り線を引く（Shift で角度を固定）';
  }
}

function stepLabel(s) {
  const cls = s.kind === 'rotate' || s.type === 'flip' ? 'other' : s.type;
  if (s.caption) return { text: s.caption, cls };
  if (s.kind === 'rotate') return { text: `${Math.round(s.full)}° 回す`, cls };
  if (s.type === 'flip') return { text: '裏返す', cls };
  const t = s.type === 'valley' ? '谷折り' : '山折り';
  return { text: s.mode === 'component' ? `${t}（一部）` : t, cls };
}

function renderSteps() {
  const ol = $('steps');
  ol.innerHTML = '';
  $('sim-note').hidden = !simMode;
  if (simMode) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="num">1</span><span><span class="tag valley"></span>折り目にそって一度に折る</span>';
    const r = document.createElement('input');
    r.type = 'range'; r.min = 0; r.max = 100; r.step = 0.5; r.value = simMode.q * 100;
    r.title = '折り具合';
    r.dataset.sim = '1';
    r.addEventListener('input', () => {
      if (busy) { r.value = simMode.q * 100; return; }
      simMode.q = +r.value / 100;
      dirty = true;
    });
    li.appendChild(r);
    ol.appendChild(li);
    $('step-count').textContent = '';
    return;
  }
  state.steps.forEach((s, i) => {
    const li = document.createElement('li');
    if (i === currentStep) li.classList.add('current');
    const { text, cls } = stepLabel(s);
    li.innerHTML = `<span class="num">${i + 1}</span><span><span class="tag ${cls}"></span>${text}</span>`;
    if (s.kind === 'fold' && s.type !== 'flip') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 180; r.step = 1; r.value = s.angle;
      r.title = '開き具合';
      r.dataset.idx = i;
      r.addEventListener('pointerdown', (e) => e.stopPropagation());
      r.addEventListener('click', (e) => e.stopPropagation());
      r.addEventListener('input', () => {
        if (busy) { r.value = state.steps[i].angle; return; }
        state.steps[i].angle = +r.value;
        cancelInput();
        dirty = true;
      });
      li.appendChild(r);
    } else {
      li.appendChild(document.createElement('span'));
    }
    li.title = 'クリックでこの手順まで表示';
    li.addEventListener('click', () => goToStep(i));
    ol.appendChild(li);
  });
  $('step-count').textContent = state.steps.length ? `${state.steps.length} 手` : '';
  if (currentStep >= 0) ol.children[currentStep]?.scrollIntoView({ block: 'nearest' });
}

function syncStepSliders() {
  if (simMode) {
    const r = $('steps').querySelector('input[data-sim]');
    if (r) r.value = simMode.q * 100;
    return;
  }
  for (const r of $('steps').querySelectorAll('input[type=range]')) {
    const s = state.steps[+r.dataset.idx];
    if (s) r.value = s.angle;
  }
}

function updateButtons() {
  $('btn-undo').disabled = busy || (!undoStack.length && !simMode);
  $('btn-redo').disabled = busy || !redoStack.length || !!simMode;
  for (const id of ['btn-replay', 'btn-unfold', 'btn-refold']) $(id).disabled = busy || (!state.steps.length && !simMode);
  for (const id of ['btn-flip', 'btn-rotate', 'btn-reset']) $(id).disabled = busy;
  for (const b of $('presets').children) b.disabled = busy;
}

function bindSeg(group, key, after) {
  const el = document.querySelector(`.seg[data-group="${group}"]`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(group, key, b.dataset.value);
    after?.();
  });
}

function setSeg(group, key, value) {
  ui[key] = value;
  for (const b of document.querySelectorAll(`.seg[data-group="${group}"] button`)) {
    b.classList.toggle('on', b.dataset.value === value);
  }
  updatePreview();
  updateHint();
}

bindSeg('input', 'input', cancelInput);
bindSeg('type', 'type');
bindSeg('mode', 'mode');

$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-flip').onclick = doFlip;
$('btn-rotate').onclick = doRotate;
$('btn-reset').onclick = () => reset();
$('btn-replay').onclick = replay;
$('btn-unfold').onclick = () => setAllAngles(true);
$('btn-refold').onclick = () => setAllAngles(false);
$('btn-view-top').onclick = () => setView('top');
$('btn-view-angle').onclick = () => setView('angle');
$('btn-view-side').onclick = () => setView('side');
$('btn-orbit').onclick = () => {
  ui.orbit = !ui.orbit;
  $('btn-orbit').classList.toggle('on', ui.orbit);
  cancelInput();
  setOrbitButtons();
  updateHint();
};
$('btn-panel').onclick = () => $('panel').classList.toggle('open');

$('paper-shape').onchange = (e) => reset(e.target.value);
$('paper-pattern').onchange = (e) => { ui.pattern = e.target.value; updateTextures(); };
$('color-front').oninput = (e) => { ui.frontColor = e.target.value; updateTextures(); drawCreasePattern(); };
$('color-back').oninput = (e) => { ui.backColor = e.target.value; updateTextures(); };
$('speed').oninput = (e) => { ui.speed = +e.target.value; };

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.onclick = () => { playPreset(p); $('panel').classList.remove('open'); };
  $('presets').appendChild(b);
}

// ================================================================ BGM

const bgm = new Bgm();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};
bgm.volume = store.get('origami.bgmVolume', 0.5);
$('bgm-volume').value = bgm.volume;

function syncBgmButtons() {
  for (const id of ['btn-bgm', 'btn-bgm2']) {
    $(id).classList.toggle('on', bgm.playing);
    $(id).setAttribute('aria-pressed', String(bgm.playing));
  }
  $('btn-bgm2').textContent = bgm.playing ? '♪ BGM を止める' : '♪ BGM を流す';
}

async function toggleBgm() {
  if (bgm.playing) bgm.stop();
  else if (!(await bgm.start())) toast('このブラウザでは音を出せません');
  store.set('origami.bgm', bgm.playing);
  syncBgmButtons();
}

$('btn-bgm').onclick = toggleBgm;
$('btn-bgm2').onclick = toggleBgm;
$('bgm-volume').oninput = (e) => { bgm.setVolume(+e.target.value); store.set('origami.bgmVolume', +e.target.value); };
// 前回 BGM をオンにしていたら、最初に画面を触ったときに流す（ブラウザは操作前の自動再生を止めるため）
if (store.get('origami.bgm', false)) {
  window.addEventListener('pointerdown', async function once() {
    window.removeEventListener('pointerdown', once, true);
    if (!bgm.playing) { await bgm.start(); syncBgmButtons(); }
  }, true);
}
syncBgmButtons();

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') cancelInput();
  else if (k === 'v') setSeg('type', 'type', 'valley');
  else if (k === 'm') setSeg('type', 'type', 'mountain');
  else if (k === 'f') doFlip();
  else if (k === 'r') doRotate();
  else if (k === 'b') toggleBgm();
  else if (k === 'shift') { input.shift = true; }
});

// ================================================================ 展開図

function drawCreasePattern() {
  const c = $('cp');
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const pw = state.width;
  const ph = state.height;
  const pad = 24;
  const scale = Math.min((W - 2 * pad) / pw, (H - 2 * pad) / ph);
  const ox = W / 2;
  const oy = H / 2;
  const tx = (u) => ox + u * scale;
  const ty = (v) => oy - v * scale;

  // 紙
  g.fillStyle = ui.frontColor + '22';
  g.fillRect(tx(-pw / 2), ty(ph / 2), pw * scale, ph * scale);

  if (simMode) {
    g.lineWidth = 2;
    g.strokeStyle = '#2b2622';
    g.strokeRect(tx(-pw / 2), ty(ph / 2), pw * scale, ph * scale);
    const uv = simMode.model.uv;
    for (const [i, j, type] of simMode.model.creaseLines) {
      g.strokeStyle = type === 'V' ? '#2f6fd6' : '#d2392b';
      g.setLineDash(type === 'V' ? [10, 6] : [10, 4, 2, 4]);
      g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(tx(uv[i][0]), ty(uv[i][1]));
      g.lineTo(tx(uv[j][0]), ty(uv[j][1]));
      g.stroke();
    }
    g.setLineDash([]);
    return;
  }

  // 表が上を向いている面を少し濃く
  for (const f of state.faces) {
    g.beginPath();
    f.verts.forEach((v, i) => (i ? g.lineTo(tx(v.u), ty(v.v)) : g.moveTo(tx(v.u), ty(v.v))));
    g.closePath();
    g.fillStyle = isFrontUp(f) ? ui.frontColor + '30' : 'rgba(0,0,0,0)';
    g.fill();
  }

  g.lineWidth = 2;
  g.strokeStyle = '#2b2622';
  g.setLineDash([]);
  g.strokeRect(tx(-pw / 2), ty(ph / 2), pw * scale, ph * scale);

  for (const cr of creasePattern(state)) {
    if (cr.type === 'flat') {
      g.strokeStyle = 'rgba(0,0,0,.18)';
      g.setLineDash([]);
      g.lineWidth = 1;
    } else if (cr.type === 'valley') {
      g.strokeStyle = '#2f6fd6';
      g.setLineDash([10, 6]);
      g.lineWidth = 2.2;
    } else {
      g.strokeStyle = '#d2392b';
      g.setLineDash([10, 4, 2, 4]);
      g.lineWidth = 2.2;
    }
    g.beginPath();
    g.moveTo(tx(cr.a.u), ty(cr.a.v));
    g.lineTo(tx(cr.b.u), ty(cr.b.v));
    g.stroke();
  }
  g.setLineDash([]);
}

// ================================================================ ループ

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  const prevAspect = camera.aspect;
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  // 縦長の画面では紙がはみ出さないように少し離れる
  const fit = (a) => 5.6 * Math.max(1, 0.95 / a);
  const offset = camera.position.clone().sub(controls.target);
  offset.multiplyScalar(fit(camera.aspect) / fit(prevAspect));
  camera.position.copy(controls.target).add(offset);
}
window.addEventListener('resize', resize);

function loop() {
  requestAnimationFrame(loop);
  // 注視点をゆっくり紙の中心へ
  const d = targetGoal.clone().sub(controls.target);
  if (d.lengthSq() > 1e-8 && input.phase === 'idle') {
    d.multiplyScalar(0.08);
    controls.target.add(d);
    camera.position.add(d);
  }
  controls.update();
  if (dirty) {
    rebuildGeometry();
    dirty = false;
  }
  renderer.render(scene, camera);
}

updateTextures();
resize();
renderSteps();
drawCreasePattern();
updateButtons();
updateHint();
loop();

// デバッグ・テスト用
window.__origami = {
  get state() { return state; },
  get busy() { return busy; },
  playPreset: (id) => playPreset(PRESETS.find((p) => p.id === id)),
  get simMode() { return simMode; },
  bgm,
  setView,
  camera,
  controls,
};
