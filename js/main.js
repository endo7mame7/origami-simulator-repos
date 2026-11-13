import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createPaper, fold, flip, rotate, makeLine, bisectorLine, sideOf, reflectPoint,
  poseFaces, creasePattern, snapPoints, bounds, cloneState, LAYER_GAP, isFrontUp,
  squash, reverseFold, petalFold, addCrease, creaseSegmentsXY, faceAffine, clipToFaceUV,
} from './paper.js';
import { VERSION } from './version.js';
import { PRESETS, applyOp } from './presets.js';
import { Bgm } from './bgm.js';

// ================================================================ 状態

const PAPER_SHAPES = {
  square: [2, 2],
  a4: [2 / Math.SQRT2, 2],
  strip: [1, 2],
};

const ui = {
  input: 'line',      // 'line' | 'point'
  type: 'valley',     // 'valley' | 'mountain' | 'crease' | 'squash' | 'reverse'
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

// 折り筋（開いた後に残る線）
const markGeom = new THREE.BufferGeometry();
const marks = new THREE.LineSegments(markGeom, new THREE.LineBasicMaterial({
  color: 0x5a4a40, transparent: true, opacity: 0.55,
}));
scene.add(marks);


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
  // 折り筋を、各面の今の姿勢に合わせて描く（表と裏の両方から見えるように少し浮かせる）
  const mp = [];
  const cm = state.creaseMarks ?? [];
  if (cm.length) {
    for (const { face, pts } of posed) {
      const map = faceAffine(face, pts);
      const n = new THREE.Vector3().crossVectors(
        new THREE.Vector3(...pts[1]).sub(new THREE.Vector3(...pts[0])),
        new THREE.Vector3(...pts[2]).sub(new THREE.Vector3(...pts[0])),
      ).normalize().multiplyScalar(0.0012);
      for (const m of cm) {
        const r = clipToFaceUV(face, m.a, m.b);
        if (!r) continue;
        const at = (t) => map(m.a.u + (m.b.u - m.a.u) * t, m.a.v + (m.b.v - m.a.v) * t);
        const a = at(r[0]);
        const b = at(r[1]);
        for (const sg of [1, -1]) {
          mp.push(a[0] + n.x * sg, a[1] + n.y * sg, a[2] + n.z * sg, b[0] + n.x * sg, b[1] + n.y * sg, b[2] + n.z * sg);
        }
      }
    }
  }
  markGeom.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
  markGeom.computeBoundingSphere();
  lastPoseMinZ = minZ;
  ground.position.z = Math.min(0, minZ) - 0.02;
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

// 同時に動く手順（つぶし折りなど）をまとめる
function stepGroups() {
  const groups = [];
  state.steps.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && s.group && state.steps[last[0]].group === s.group) last.push(i);
    else groups.push([i]);
  });
  return groups;
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
  // 新しい手順（つぶし折りなどは複数の手順を同時に動かす）
  const targets = {};
  for (let i = prevSteps.length; i < state.steps.length; i++) {
    targets[i] = targetAngle ?? fullAngle(state.steps[i]);
    state.steps[i].angle = 0;
  }
  currentStep = prevSteps.length;
  dirty = true;
  renderSteps();
  drawCreasePattern();
  await animateAngles(targets);
  recenter();
  return true;
}

// ================================================================ 操作

// 今の設定で折った結果を計算する（プレビューにも使う）
function computeFold(line, side, pick) {
  const p = pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' };
  if (ui.type === 'squash') return squash(state, { line, side, pick: p });
  if (ui.type === 'reverse') return reverseFold(state, { line, side, pick: p });
  if (ui.type === 'petal') return petalFold(state, { line, side, pick: p });
  const type = ui.type === 'crease' ? 'valley' : ui.type;
  return fold(state, { line, side, type, mode: ui.mode, pick: p });
}

function doFold(line, side, pick) {
  return runBusy(async () => {
    await flattenAll();
    if (ui.type === 'crease') {
      // 折ってから開いて、折り筋だけを残す
      const before = cloneState(state);
      const c = addCrease(state, { line, side, mode: ui.mode, pick: pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' } });
      if (c.error) { toast(c.error); return; }
      if (!c.marks.length) { toast('折り筋がつきませんでした'); return; }
      if (!(await commit({ state: c.folded }))) return;
      await wait(120 / ui.speed);
      const idx = state.steps.length - 1;
      await animateAngles({ [idx]: 0 }, 600);
      const angles = before.steps.map((st, i) => state.steps[i].angle);
      state = c.state;
      state.steps.forEach((st, i) => { st.angle = angles[i]; });
      dirty = true;
      drawCreasePattern();
      return;
    }
    await commit(computeFold(line, side, pick));
  });
}

function doFlip() {
  return runBusy(async () => { await flattenAll(); await commit(flip(state)); });
}

function doRotate() {
  return runBusy(async () => { await flattenAll(); await commit(rotate(state, 90)); });
}

function undo() {
  if (!undoStack.length) return;
  runBusy(async () => {
    // この操作で増えた手順だけを開く（折り筋は手順が増えないので、そのまま戻す）
    const prevLen = undoStack[undoStack.length - 1].steps.length;
    const t = {};
    for (let i = prevLen; i < state.steps.length; i++) t[i] = 0;
    await animateAngles(t);
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
  if (!redoStack.length) return;
  runBusy(async () => {
    const next = redoStack.pop();
    undoStack.push(cloneState(state));
    const prevLen = state.steps.length;
    const goals = {};
    for (let i = prevLen; i < next.steps.length; i++) goals[i] = next.steps[i].angle;
    state.steps.forEach((s, i) => { next.steps[i].angle = s.angle; });
    state = next;
    if (next.steps.length > prevLen) {
      for (const i of Object.keys(goals)) state.steps[i].angle = 0;
      currentStep = prevLen;
      renderSteps();
      await animateAngles(goals);
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
  if (!state.steps.length) return;
  runBusy(async () => {
    const targets = state.steps.map((s) => (s.angle > 0 ? s.angle : fullAngle(s)));
    const all = {};
    state.steps.forEach((s, i) => { all[i] = 0; });
    await animateAngles(all, 600);
    await wait(250);
    for (const g of stepGroups()) {
      currentStep = g[0];
      renderSteps();
      const t = {};
      for (const i of g) t[i] = targets[i];
      await animateAngles(t);
      await wait(120 / ui.speed);
    }
  });
}

function setAllAngles(open) {
  runBusy(async () => {
    const t = {};
    state.steps.forEach((s, i) => { t[i] = open ? 0 : fullAngle(s); });
    await animateAngles(t, 900);
  });
}

// i 番目の手順まで折った状態を見せる
function goToStep(i) {
  runBusy(async () => {
    const t = {};
    const last = stepGroups().find((g) => g.includes(i)) ?? [i];
    const end = last[last.length - 1];
    state.steps.forEach((s, j) => { t[j] = j <= end ? fullAngle(s) : 0; });
    currentStep = last[0];
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
  runBusy(async () => {
    await wait(200);
    for (const op of preset.steps) {
      const first = state.steps.length;
      const ok = await commit(applyOp(state, op));
      if (!ok) break;
      if (state.steps[first]) state.steps[first].caption = op.caption;
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
  if (!snapCache || snapCache.state !== state) {
    const pts = snapPoints(state);
    // 折り筋の端と、折り筋どうしの交点
    const segs = creaseSegmentsXY(state);
    for (const sg of segs) pts.push({ ...sg.a, kind: 'vertex' }, { ...sg.b, kind: 'vertex' });
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const p = segIntersect(segs[i], segs[j]);
        if (p) pts.push({ ...p, kind: 'vertex' });
      }
    }
    snapCache = { state, pts, segs };
  }
  return snapCache.pts;
}

function segIntersect(s1, s2) {
  const rx = s1.b.x - s1.a.x, ry = s1.b.y - s1.a.y;
  const sx = s2.b.x - s2.a.x, sy = s2.b.y - s2.a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = s2.a.x - s1.a.x, qy = s2.a.y - s1.a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: s1.a.x + rx * t, y: s1.a.y + ry * t };
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
  if (best) return { pt: { x: best.x, y: best.y }, snapped: true };
  // 点がなければ、折り筋の線の上に吸い付く
  let bl = r * 0.8;
  let onSeg = null;
  for (const sg of snapCache?.segs ?? []) {
    const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y;
    const L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((pt.x - sg.a.x) * dx + (pt.y - sg.a.y) * dy) / L2));
    const q = { x: sg.a.x + dx * t, y: sg.a.y + dy * t };
    const d = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (d < bl) { bl = d; onSeg = q; }
  }
  return onSeg ? { pt: onSeg, snapped: true } : { pt, snapped: false };
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
    if (ui.input === 'point' && (ui.type === 'squash' || ui.type === 'petal')) {
      cancelInput();
      toast('「袋をつぶす」と「花弁折り」は「線」モードで線を引いてください');
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
  foldLineMat.color.set({ valley: 0x2f6fd6, mountain: 0xd2392b, crease: 0x6b5a4e, squash: 0x7a3fb0, reverse: 0x0f8a6a, petal: 0xc06a12 }[ui.type]);
  previewGroup.add(lineQuad(a, b, w, z, foldLineMat));

  if (!side) return;
  // 動く部分の強調表示と、折った後の位置（点線）
  if ((ui.type === 'squash' || ui.type === 'petal') && ui.input === 'point') return;
  const r = computeFold(line, side, pick);
  if (r.error) return;
  const first = state.steps.length;
  for (const f of r.state.faces) {
    const mine = f.moves.filter((k) => k >= first);
    if (!mine.length) continue;
    // 新しい手順の鏡映を逆にたどって、元の位置を求める
    let orig = f.verts.map((v) => ({ x: v.x, y: v.y }));
    for (let q = mine.length - 1; q >= 0; q--) {
      const st = r.state.steps[mine[q]];
      orig = orig.map((v) => reflectPoint(st, v));
    }
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
  if (input.phase === 'choose') {
    el.textContent = ui.type === 'squash' ? 'つぶしたい袋をクリック（Esc で取り消し）'
      : ui.type === 'reverse' ? '折り込みたい袋の先をクリック（Esc で取り消し）'
      : ui.type === 'petal' ? '持ち上げる角の側をクリック（Esc で取り消し）'
      : ui.mode === 'component' ? '折りたい部分をクリック（Esc で取り消し）'
      : '折りたい側をクリック（Esc で取り消し）';
    return;
  }
  if (ui.type === 'squash') { el.textContent = '袋のつけ根（ちょうつがいの折り目）に沿って線を引こう'; return; }
  if (ui.type === 'reverse') { el.textContent = '袋の途中に折り線を引いて、折り込む先をクリック'; return; }
  if (ui.type === 'petal') { el.textContent = '花弁のつけ根の横線を、1 枚目の左右のふちの間に引こう'; return; }
  if (ui.input === 'point') {
    el.textContent = '動かしたい点を、重ねたい点までドラッグ';
  } else {
    el.textContent = state.steps.length === 0
      ? '紙の上をドラッグして折り線を引こう'
      : 'ドラッグで折り線を引く（Shift で角度を固定）';
  }
}

function stepLabel(s) {
  const cls = s.kind === 'rotate' || s.type === 'flip' ? 'other'
    : s.type === 'squash' || s.type === 'reverse' || s.type === 'petal' ? 'special' : s.type;
  if (s.label && !s.caption) return { text: s.label, cls };
  if (s.caption) return { text: s.caption, cls };
  if (s.kind === 'rotate') return { text: `${Math.round(s.full)}° 回す`, cls };
  if (s.type === 'flip') return { text: '裏返す', cls };
  const t = s.type === 'valley' ? '谷折り' : '山折り';
  return { text: s.mode === 'component' ? `${t}（一部）` : t, cls };
}

function renderSteps() {
  const ol = $('steps');
  ol.innerHTML = '';
  const groups = stepGroups();
  groups.forEach((g, n) => {
    const i = g[0];
    const s = state.steps[i];
    const li = document.createElement('li');
    if (g.includes(currentStep)) li.classList.add('current');
    const { text, cls } = stepLabel(s);
    li.innerHTML = `<span class="num">${n + 1}</span><span><span class="tag ${cls}"></span>${text}</span>`;
    if (s.kind === 'fold' && s.type !== 'flip') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 180; r.step = 1; r.value = s.angle;
      r.title = '開き具合';
      r.dataset.idx = i;
      r.addEventListener('pointerdown', (e) => e.stopPropagation());
      r.addEventListener('click', (e) => e.stopPropagation());
      r.addEventListener('input', () => {
        if (busy) { r.value = state.steps[i].angle; return; }
        for (const j of g) state.steps[j].angle = +r.value;
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
  $('step-count').textContent = groups.length ? `${groups.length} 手` : '';
  const cur = groups.findIndex((g) => g.includes(currentStep));
  if (cur >= 0) ol.children[cur]?.scrollIntoView({ block: 'nearest' });
}

function syncStepSliders() {
  for (const r of $('steps').querySelectorAll('input[type=range]')) {
    const s = state.steps[+r.dataset.idx];
    if (s) r.value = s.angle;
  }
}

function updateButtons() {
  $('btn-undo').disabled = busy || !undoStack.length;
  $('btn-redo').disabled = busy || !redoStack.length;
  for (const id of ['btn-replay', 'btn-unfold', 'btn-refold']) $(id).disabled = busy || !state.steps.length;
  for (const id of ['btn-flip', 'btn-rotate', 'btn-reset']) $(id).disabled = busy;
  for (const b of $('presets').children) b.disabled = busy;
}

function bindSeg(group, key, after) {
  for (const el of document.querySelectorAll(`.seg[data-group="${group}"]`)) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setSeg(group, key, b.dataset.value);
      after?.();
    });
  }
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
bindSeg('type', 'type', () => { if (input.phase === 'choose') updatePreview(); });
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
  else if (k === 'c') setSeg('type', 'type', 'crease');
  else if (k === 's') setSeg('type', 'type', 'squash');
  else if (k === 'i') setSeg('type', 'type', 'reverse');
  else if (k === 'o') setSeg('type', 'type', 'petal');
  else if (k === 'l') { setSeg('input', 'input', 'line'); cancelInput(); }
  else if (k === 'p') { setSeg('input', 'input', 'point'); cancelInput(); }
  else if (k === 'a') setSeg('mode', 'mode', 'all');
  else if (k === 't') setSeg('mode', 'mode', 'component');
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

  // 折り筋（灰色の細い線）
  g.strokeStyle = 'rgba(90,74,64,.6)';
  g.setLineDash([3, 3]);
  g.lineWidth = 1.2;
  for (const m of state.creaseMarks ?? []) {
    g.beginPath();
    g.moveTo(tx(m.a.u), ty(m.a.v));
    g.lineTo(tx(m.b.u), ty(m.b.v));
    g.stroke();
  }
  g.setLineDash([]);

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

$('version').textContent = `v${VERSION}`;
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
  bgm,
  setView,
  camera,
  controls,
};
