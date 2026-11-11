// 折り紙の幾何モデル（描画ライブラリに依存しない純粋なロジック）
//
// 紙は「面（face）」の集合として表現する。各面は凸多角形で、
//   - verts: 頂点の配列。x, y は「平らに折りたたまれた状態」での位置、
//            u, v は元の紙（展開図）上での位置。
//   - layer: 重なり順（大きいほど上）。
//   - moves: この面を動かした手順（steps の添字）の一覧。
// を持つ。折るたびに折り線で面を分割し、動く側の面を折り線で鏡映する。
//
// 3D 表示では、各手順に「開き具合（角度）」を持たせ、面を動かした手順の
// 回転を順に合成することで、途中まで開いた立体的な形も表現できる。

export const LAYER_GAP = 0.004;
const TOL = 1e-9;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 基本関数

const cross2 = (ax, ay, bx, by) => ax * by - ay * bx;

export function makeLine(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { p: { x: a.x, y: a.y }, d: { x: dx / len, y: dy / len } };
}

// 点 a を点 b に重ねる折り線（a と b の垂直二等分線）
export function bisectorLine(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return {
    p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    d: { x: -dy / len, y: dx / len },
  };
}

export function sideOf(line, pt) {
  return cross2(line.d.x, line.d.y, pt.x - line.p.x, pt.y - line.p.y);
}

export function reflectPoint(line, pt) {
  const vx = pt.x - line.p.x;
  const vy = pt.y - line.p.y;
  const along = vx * line.d.x + vy * line.d.y;
  const ax = along * line.d.x;
  const ay = along * line.d.y;
  return { x: line.p.x + 2 * ax - vx, y: line.p.y + 2 * ay - vy };
}

export function signedArea(verts, key = 'xy') {
  const [kx, ky] = key === 'uv' ? ['u', 'v'] : ['x', 'y'];
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    a += p[kx] * q[ky] - q[kx] * p[ky];
  }
  return a / 2;
}

// 表が上を向いているか（展開図と同じ回り順なら表が上）
export function isFrontUp(face) {
  return signedArea(face.verts, 'xy') * signedArea(face.verts, 'uv') > 0;
}

export function pointInFace(face, pt) {
  const vs = face.verts;
  let sign = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    const c = cross2(b.x - a.x, b.y - a.y, pt.x - a.x, pt.y - a.y);
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function bounds(state) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of state.faces) {
    for (const v of f.verts) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ---------------------------------------------------------------- 状態

export function createPaper(width = 2, height = 2) {
  const hw = width / 2;
  const hh = height / 2;
  const verts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    .map(([x, y]) => ({ x, y, u: x, v: y }));
  return {
    width,
    height,
    faces: [{ id: 0, verts, layer: 0, moves: [] }],
    steps: [],
    nextId: 1,
  };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- 分割

function lerpVert(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
  };
}

function cleanPolygon(verts) {
  const out = [];
  for (const v of verts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - v.x, last.y - v.y) < 1e-9) continue;
    out.push(v);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) out.pop();
  }
  return out;
}

// 凸多角形の面を直線で分割する。
// 戻り値: { pos, neg }（直線の左側 = pos）。分割されない場合は片方が null。
export function splitFace(face, line) {
  const vs = face.verts;
  const s = vs.map((v) => {
    const d = sideOf(line, v);
    return Math.abs(d) < TOL ? 0 : d;
  });
  const hasPos = s.some((d) => d > 0);
  const hasNeg = s.some((d) => d < 0);
  if (!hasNeg) return { pos: face, neg: null };
  if (!hasPos) return { pos: null, neg: face };

  const pos = [];
  const neg = [];
  for (let i = 0; i < vs.length; i++) {
    const j = (i + 1) % vs.length;
    const a = vs[i];
    const b = vs[j];
    if (s[i] >= 0) pos.push(a);
    if (s[i] <= 0) neg.push(a);
    if ((s[i] > 0 && s[j] < 0) || (s[i] < 0 && s[j] > 0)) {
      const t = s[i] / (s[i] - s[j]);
      const m = lerpVert(a, b, t);
      pos.push(m);
      neg.push({ ...m });
    }
  }
  const p = cleanPolygon(pos);
  const n = cleanPolygon(neg);
  const minArea = 1e-10;
  if (p.length < 3 || Math.abs(signedArea(p)) < minArea) return { pos: null, neg: face };
  if (n.length < 3 || Math.abs(signedArea(n)) < minArea) return { pos: face, neg: null };
  return {
    pos: { ...face, verts: p },
    neg: { ...face, verts: n.map((v) => ({ ...v })) },
  };
}

// ---------------------------------------------------------------- 隣接（展開図上で辺を共有しているか）

function edgesOverlapUV(a, b, c, d) {
  const ex = b.u - a.u;
  const ey = b.v - a.v;
  const len = Math.hypot(ex, ey);
  if (len < 1e-9) return false;
  const tol = 1e-7 * Math.max(1, len);
  if (Math.abs(cross2(ex, ey, c.u - a.u, c.v - a.v)) / len > tol) return false;
  if (Math.abs(cross2(ex, ey, d.u - a.u, d.v - a.v)) / len > tol) return false;
  const tc = ((c.u - a.u) * ex + (c.v - a.v) * ey) / (len * len);
  const td = ((d.u - a.u) * ex + (d.v - a.v) * ey) / (len * len);
  const lo = Math.max(0, Math.min(tc, td));
  const hi = Math.min(1, Math.max(tc, td));
  return (hi - lo) * len > 1e-6;
}

export function sharedEdge(fa, fb) {
  const A = fa.verts;
  const B = fb.verts;
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    const b = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const c = B[j];
      const d = B[(j + 1) % B.length];
      if (edgesOverlapUV(a, b, c, d)) return [a, b];
    }
  }
  return null;
}

// ---------------------------------------------------------------- 折る

function normalizeLayers(faces) {
  const uniq = [...new Set(faces.map((f) => f.layer))].sort((a, b) => a - b);
  const rank = new Map(uniq.map((l, i) => [l, i]));
  for (const f of faces) f.layer = rank.get(f.layer);
}

/**
 * 紙を折る。
 * @param state 現在の状態（変更しない）
 * @param opts {
 *   line: {p, d}       折り線
 *   side: +1 | -1      動かす側（sideOf の符号）
 *   type: 'valley' | 'mountain'
 *   mode: 'all' | 'component'   すべての層を折るか、選んだ部分だけ折るか
 *   pick: {x, y, select: 'top'|'bottom'}  component のときに選ぶ位置
 * }
 * @returns { state } または { error }
 */
export function fold(state, opts) {
  const { line, side, type = 'valley', mode = 'all', pick } = opts;
  if (!line) return { error: '折り線が短すぎます' };
  const stepIndex = state.steps.length;

  // 1. すべての面を折り線で分割
  const pieces = []; // { face, side, src }
  state.faces.forEach((face, src) => {
    const { pos, neg } = splitFace(face, line);
    if (pos) pieces.push({ face: pos, side: 1, src, split: !!(pos && neg) });
    if (neg) pieces.push({ face: neg, side: -1, src, split: !!(pos && neg) });
  });

  // 2. 動かす面を決める
  const candidates = pieces.filter((p) => p.side === side);
  let moving;
  if (mode === 'component') {
    if (!pick) return { error: '折る部分を選んでください' };
    const under = candidates.filter((p) => pointInFace(p.face, pick));
    if (under.length === 0) return { error: 'その位置に紙がありません' };
    const pickBottom = pick.select === 'bottom';
    under.sort((a, b) => (pickBottom ? a.face.layer - b.face.layer : b.face.layer - a.face.layer));
    const seed = under[0];
    const set = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
      const cur = queue.pop();
      for (const c of candidates) {
        if (set.has(c)) continue;
        if (sharedEdge(cur.face, c.face)) {
          set.add(c);
          queue.push(c);
        }
      }
    }
    moving = set;
  } else {
    moving = new Set(candidates);
  }
  if (moving.size === 0) return { error: '折り線のその側には紙がありません' };

  // 3. 動かない側の分割は元に戻す（無駄な分割を残さない）
  const movedSrc = new Set([...moving].map((p) => p.src));
  const out = [];
  let nextId = state.nextId;
  const handledSrc = new Set();
  for (const p of pieces) {
    if (moving.has(p)) {
      out.push({ piece: p, moving: true });
    } else if (p.split && !movedSrc.has(p.src)) {
      if (handledSrc.has(p.src)) continue;
      handledSrc.add(p.src);
      out.push({ piece: { ...p, face: state.faces[p.src], split: false }, moving: false });
    } else {
      out.push({ piece: p, moving: false });
    }
  }

  // 4. 重なり順
  const movingLayers = [...moving].map((p) => p.face.layer);
  const allLayers = state.faces.map((f) => f.layer);
  const maxAll = Math.max(...allLayers);
  const minAll = Math.min(...allLayers);
  const maxMov = Math.max(...movingLayers);
  const minMov = Math.min(...movingLayers);

  const faces = out.map(({ piece, moving: isMoving }) => {
    const f = piece.face;
    const keepId = !piece.split;
    const id = keepId ? f.id : nextId++;
    if (!isMoving) {
      return { id, verts: f.verts.map((v) => ({ ...v })), layer: f.layer, moves: [...f.moves] };
    }
    const verts = f.verts.map((v) => {
      const r = reflectPoint(line, v);
      return { x: r.x, y: r.y, u: v.u, v: v.v };
    });
    const layer = type === 'valley'
      ? maxAll + 1 + (maxMov - f.layer)
      : minAll - 1 - (f.layer - minMov);
    return { id, verts, layer, moves: [...f.moves, stepIndex] };
  });
  normalizeLayers(faces);

  const k = (type === 'valley' ? side : -side);
  const step = {
    kind: 'fold',
    type,
    mode,
    p: { ...line.p },
    d: { ...line.d },
    k: { x: line.d.x * k, y: line.d.y * k },
    angle: 180,
  };

  return {
    state: {
      ...state,
      faces,
      steps: [...state.steps.map((s) => ({ ...s })), step],
      nextId,
    },
  };
}

// 紙全体を裏返す（縦の軸まわりに 180° 回す）
export function flip(state) {
  const b = bounds(state);
  const line = { p: { x: b.cx, y: b.cy }, d: { x: 0, y: 1 } };
  const stepIndex = state.steps.length;
  const maxL = Math.max(...state.faces.map((f) => f.layer));
  const faces = state.faces.map((f) => ({
    id: f.id,
    verts: f.verts.map((v) => {
      const r = reflectPoint(line, v);
      return { x: r.x, y: r.y, u: v.u, v: v.v };
    }),
    layer: maxL - f.layer,
    moves: [...f.moves, stepIndex],
  }));
  const step = { kind: 'fold', type: 'flip', mode: 'all', p: line.p, d: line.d, k: { x: 0, y: 1 }, angle: 180 };
  return { state: { ...state, faces, steps: [...state.steps.map((s) => ({ ...s })), step] } };
}

// 紙全体を机の上で回す（deg 度。反時計回りが正）
export function rotate(state, deg = 90) {
  const b = bounds(state);
  const c = { x: b.cx, y: b.cy };
  const stepIndex = state.steps.length;
  const r = deg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const faces = state.faces.map((f) => ({
    id: f.id,
    verts: f.verts.map((v) => {
      const dx = v.x - c.x;
      const dy = v.y - c.y;
      return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos, u: v.u, v: v.v };
    }),
    layer: f.layer,
    moves: [...f.moves, stepIndex],
  }));
  const step = { kind: 'rotate', type: 'rotate', c, full: deg, angle: deg };
  return { state: { ...state, faces, steps: [...state.steps.map((s) => ({ ...s })), step] } };
}

// ---------------------------------------------------------------- 3D の姿勢

// 点 P を、点 p を通り方向 k（xy 平面内の単位ベクトル）の軸まわりに theta 回す
function rotateAboutAxis(P, p, k, theta) {
  const vx = P[0] - p.x;
  const vy = P[1] - p.y;
  const vz = P[2];
  const along = vx * k.x + vy * k.y;
  const ax = along * k.x;
  const ay = along * k.y;
  const px = vx - ax;
  const py = vy - ay;
  const pz = vz;
  // k × perp
  const cx = k.y * pz;
  const cy = -k.x * pz;
  const cz = k.x * py - k.y * px;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    p.x + ax + px * c + cx * s,
    p.y + ay + py * c + cy * s,
    pz * c + cz * s,
  ];
}

function rotateAboutZ(P, c, theta) {
  const dx = P[0] - c.x;
  const dy = P[1] - c.y;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  return [c.x + dx * co - dy * si, c.y + dx * si + dy * co, P[2]];
}

// 手順 step を「完全に折った状態」から「angle の状態」に戻す変換
function applyStep(step, P, angle) {
  if (step.kind === 'rotate') {
    return rotateAboutZ(P, step.c, (angle - step.full) * DEG);
  }
  return rotateAboutAxis(P, step.p, step.k, (angle - 180) * DEG);
}

// 平らな状態の座標を、各手順の角度に応じた 3D 座標に変換する
// angles: 手順ごとの角度（省略時は step.angle）
export function poseFaces(state, angles) {
  const steps = state.steps;
  return state.faces.map((face) => {
    const pts = face.verts.map((v) => {
      let P = [v.x, v.y, 0];
      for (let i = face.moves.length - 1; i >= 0; i--) {
        const si = face.moves[i];
        const step = steps[si];
        const a = angles ? angles[si] : step.angle;
        const full = step.kind === 'rotate' ? step.full : 180;
        if (a !== full) P = applyStep(step, P, a);
      }
      P[2] += face.layer * LAYER_GAP;
      return P;
    });
    return { face, pts };
  });
}

// ---------------------------------------------------------------- 展開図

// 隣り合う面の向きと重なり順から、山折り・谷折り（表から見て）を求める
export function creasePattern(state) {
  const faces = state.faces;
  const creases = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const e = sharedEdge(faces[i], faces[j]);
      if (!e) continue;
      const a = faces[i];
      const b = faces[j];
      const fa = isFrontUp(a);
      const fb = isFrontUp(b);
      let type = 'flat';
      if (fa !== fb) {
        const up = fa ? a : b;   // 表が上を向いている面
        const down = fa ? b : a; // 表が下を向いている面
        // 表が下向きの面が上にある → 表どうしが向かい合う → 谷折り
        type = down.layer > up.layer ? 'valley' : 'mountain';
      }
      // 実際に重なっている部分の線分を求める
      const seg = overlapSegment(a, b, e);
      creases.push({ a: seg[0], b: seg[1], type });
    }
  }
  return creases;
}

function overlapSegment(fa, fb, [a, b]) {
  const ex = b.u - a.u;
  const ey = b.v - a.v;
  const len2 = ex * ex + ey * ey;
  let lo = 0;
  let hi = 1;
  const B = fb.verts;
  for (let j = 0; j < B.length; j++) {
    const c = B[j];
    const d = B[(j + 1) % B.length];
    if (!edgesOverlapUV(a, b, c, d)) continue;
    const tc = ((c.u - a.u) * ex + (c.v - a.v) * ey) / len2;
    const td = ((d.u - a.u) * ex + (d.v - a.v) * ey) / len2;
    lo = Math.max(0, Math.min(tc, td));
    hi = Math.min(1, Math.max(tc, td));
    break;
  }
  return [
    { u: a.u + ex * lo, v: a.v + ey * lo },
    { u: a.u + ex * hi, v: a.v + ey * hi },
  ];
}

// スナップ候補（面の頂点と辺の中点）
export function snapPoints(state) {
  const pts = [];
  const seen = new Set();
  const add = (x, y, kind) => {
    const key = `${x.toFixed(5)},${y.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pts.push({ x, y, kind });
  };
  for (const f of state.faces) {
    for (const v of f.verts) add(v.x, v.y, 'vertex');
  }
  for (const f of state.faces) {
    const vs = f.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      add((a.x + b.x) / 2, (a.y + b.y) / 2, 'mid');
    }
  }
  return pts;
}

export function totalArea(state) {
  return state.faces.reduce((s, f) => s + Math.abs(signedArea(f.verts)), 0);
}
