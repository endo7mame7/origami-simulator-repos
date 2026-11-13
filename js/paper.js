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
    faces: [{ id: 0, verts, layer: 0, moves: [], hist: [0] }],
    steps: [],
    creaseMarks: [], // 折り筋（展開図上の線分 {a:{u,v}, b:{u,v}}）
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


// ---------------------------------------------------------------- 部分の選択と重なり

// 2 つの凸多角形（平らな状態の xy）が重なっている面積
export function overlapArea(fa, fb) {
  let poly = fa.verts.map((v) => ({ x: v.x, y: v.y }));
  const B = fb.verts;
  const sb = Math.sign(signedArea(B)) || 1;
  for (let i = 0; i < B.length && poly.length; i++) {
    const a = B[i];
    const b = B[(i + 1) % B.length];
    const inside = (p) => sb * cross2(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y) > 1e-12;
    const next = [];
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j];
      const q = poly[(j + 1) % poly.length];
      const ip = inside(p);
      const iq = inside(q);
      if (ip) next.push(p);
      if (ip !== iq) {
        const d1 = cross2(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
        const d2 = cross2(b.x - a.x, b.y - a.y, q.x - a.x, q.y - a.y);
        const t = d1 / (d1 - d2);
        next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    poly = next;
  }
  return poly.length < 3 ? 0 : Math.abs(signedArea(poly));
}

function onLine(line, v) {
  return Math.abs(sideOf(line, v)) < 1e-7;
}

// 2 つの面が、折り線の上にない辺でつながっているか
function connectedOffLine(fa, fb, line) {
  const e = sharedEdge(fa, fb);
  if (!e) return false;
  if (!line) return true;
  return !(onLine(line, e[0]) && onLine(line, e[1]));
}

/**
 * pick の位置の一番上（または一番下）の紙と、それにつながっている部分を選ぶ。
 * carry: 'above' なら、選んだ部分の上に重なっている紙も一緒に動かす（紙を突き抜けないように）。
 *        'below' なら下に重なっている紙も一緒に動かす。
 * excludeLine: この線の上の辺ではつながっていないとみなす（袋のつけ根など）
 */
export function selectComponent(candidates, pick, { carry = 'none', excludeLine = null, flatOnly = false } = {}) {
  if (!pick) return { error: '折る部分を選んでください' };
  const under = candidates.filter((p) => pointInFace(p.face, pick));
  if (under.length === 0) return { error: 'その位置に紙がありません' };
  const pickBottom = pick.select === 'bottom';
  under.sort((a, b) => (pickBottom ? a.face.layer - b.face.layer : b.face.layer - a.face.layer));
  const seed = under[0];
  const set = new Set([seed]);
  const grow = (start) => {
    const queue = [...start];
    while (queue.length) {
      const cur = queue.pop();
      for (const c of candidates) {
        if (set.has(c)) continue;
        if (flatOnly && isFrontUp(cur.face) !== isFrontUp(c.face)) continue;
        if (connectedOffLine(cur.face, c.face, excludeLine)) {
          set.add(c);
          queue.push(c);
        }
      }
    }
  };
  grow([seed]);
  if (carry !== 'none') {
    // 上（下）に重なっている紙を、増えなくなるまで取り込む
    for (let changed = true; changed;) {
      changed = false;
      const added = [];
      for (const c of candidates) {
        if (set.has(c)) continue;
        for (const m of set) {
          const blocks = carry === 'above' ? c.face.layer > m.face.layer : c.face.layer < m.face.layer;
          if (blocks && overlapArea(c.face, m.face) > 1e-8) { added.push(c); break; }
        }
      }
      if (added.length) {
        for (const c of added) set.add(c);
        grow(added);
        changed = true;
      }
    }
  }
  return { set, seed };
}

// ---------------------------------------------------------------- 折る

// 各面に「それぞれの手順の時点での重なり順」を記録する（途中の段階を正しい順で描くため）。
// hist[i] = i 手目まで折ったときの重なり順。新しい面は、展開図上でそれを含む元の面の記録を引き継ぐ。
function stampHistory(prevFaces, faces, prevSteps, newSteps) {
  const inUV = (f, u, v) => {
    const vs = f.verts;
    const sg = Math.sign(signedArea(vs, 'uv')) || 1;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      if (sg * cross2(b.u - a.u, b.v - a.v, u - a.u, v - a.v) < -1e-9) return false;
    }
    return true;
  };
  for (const f of faces) {
    const n = f.verts.length;
    const cu = f.verts.reduce((s, v) => s + v.u, 0) / n;
    const cv = f.verts.reduce((s, v) => s + v.v, 0) / n;
    const src = prevFaces.find((g) => inUV(g, cu, cv));
    const h = src?.hist ? [...src.hist] : [];
    while (h.length < prevSteps + 1) h.push(src ? src.layer : f.layer);
    h.length = prevSteps + 1;
    for (let k = 0; k < newSteps; k++) h.push(f.layer);
    f.hist = h;
  }
}

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
    const r = selectComponent(candidates, pick, { carry: type === 'mountain' ? 'below' : 'above', excludeLine: line });
    if (r.error) return r;
    moving = r.set;
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
  stampHistory(state.faces, faces, state.steps.length, 1);

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


// ---------------------------------------------------------------- 折り筋

// fold() の結果から、実際に折れた部分の折り線（展開図上の線分）を取り出す
export function creaseMarksFromFold(result, line) {
  const idx = result.steps.length - 1;
  const marks = [];
  const seen = new Set();
  for (const f of result.faces) {
    if (!f.moves.includes(idx)) continue;
    const vs = f.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      if (!onLine(line, a) || !onLine(line, b)) continue;
      if (Math.hypot(a.u - b.u, a.v - b.v) < 1e-6) continue;
      const key = [a.u, a.v, b.u, b.v].map((x) => x.toFixed(5)).join(',');
      const key2 = [b.u, b.v, a.u, a.v].map((x) => x.toFixed(5)).join(',');
      if (seen.has(key) || seen.has(key2)) continue;
      seen.add(key);
      marks.push({ a: { u: a.u, v: a.v }, b: { u: b.u, v: b.v } });
    }
  }
  return marks;
}

// 折って開く（折り筋だけを残す）。状態に折り筋を足したものを返す
export function addCrease(state, opts) {
  const r = fold(state, { ...opts, type: 'valley' });
  if (r.error) return r;
  const marks = creaseMarksFromFold(r.state, opts.line);
  return { folded: r.state, marks, state: { ...cloneState(state), creaseMarks: [...(state.creaseMarks ?? []), ...marks] } };
}

// 面の展開図座標 (u,v) → 別の座標（平らな xy や 3D）への写像を、面の 3 頂点から作る
export function faceAffine(face, targets) {
  const vs = face.verts;
  let best = [0, 1, 2];
  let bestA = 0;
  for (let i = 1; i < vs.length - 1; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const a = Math.abs(cross2(vs[i].u - vs[0].u, vs[i].v - vs[0].v, vs[j].u - vs[0].u, vs[j].v - vs[0].v));
      if (a > bestA) { bestA = a; best = [0, i, j]; }
    }
  }
  const [i0, i1, i2] = best;
  const A = vs[i0], B = vs[i1], C = vs[i2];
  const det = (B.u - A.u) * (C.v - A.v) - (C.u - A.u) * (B.v - A.v);
  const T0 = targets[i0], T1 = targets[i1], T2 = targets[i2];
  return (u, v) => {
    const s = ((u - A.u) * (C.v - A.v) - (C.u - A.u) * (v - A.v)) / det;
    const t = ((B.u - A.u) * (v - A.v) - (u - A.u) * (B.v - A.v)) / det;
    return T0.map((x, k) => x + (T1[k] - x) * s + (T2[k] - x) * t);
  };
}

// 展開図上の線分を、面（展開図上で凸多角形）の内側に切り取る。[t0, t1] か null
export function clipToFaceUV(face, a, b) {
  let t0 = 0;
  let t1 = 1;
  const vs = face.verts;
  const sgn = Math.sign(signedArea(vs, 'uv')) || 1;
  const du = b.u - a.u;
  const dv = b.v - a.v;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i];
    const q = vs[(i + 1) % vs.length];
    const ex = q.u - p.u;
    const ey = q.v - p.v;
    const num = sgn * cross2(ex, ey, a.u - p.u, a.v - p.v); // >= 0 で内側
    const den = sgn * cross2(ex, ey, du, dv);
    if (Math.abs(den) < 1e-12) {
      if (num < -1e-9) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1 - 1e-9) return null;
  }
  return [t0, t1];
}

// 折り筋を、今の平らな状態の xy 座標の線分にする
export function creaseSegmentsXY(state) {
  const out = [];
  const marks = state.creaseMarks ?? [];
  if (!marks.length) return out;
  for (const f of state.faces) {
    const map = faceAffine(f, f.verts.map((v) => [v.x, v.y]));
    for (const m of marks) {
      const r = clipToFaceUV(f, m.a, m.b);
      if (!r) continue;
      const at = (t) => map(m.a.u + (m.b.u - m.a.u) * t, m.a.v + (m.b.v - m.a.v) * t);
      const [x1, y1] = at(r[0]);
      const [x2, y2] = at(r[1]);
      if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) continue;
      out.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, layer: f.layer });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 袋を開いてつぶす・中割り折り

function splitAll(state, line) {
  const pieces = [];
  state.faces.forEach((face, src) => {
    const { pos, neg } = splitFace(face, line);
    const split = !!(pos && neg);
    if (pos) pieces.push({ face: pos, side: 1, src, split });
    if (neg) pieces.push({ face: neg, side: -1, src, split });
  });
  return pieces;
}

function lineIntersect(l1, l2) {
  const den = cross2(l1.d.x, l1.d.y, l2.d.x, l2.d.y);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross2(l2.p.x - l1.p.x, l2.p.y - l1.p.y, l2.d.x, l2.d.y) / den;
  return { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
}

const reflectVerts = (verts, line) => verts.map((v) => {
  const r = reflectPoint(line, v);
  return { x: r.x, y: r.y, u: v.u, v: v.v };
});

function centroid(face) {
  const n = face.verts.length;
  return {
    x: face.verts.reduce((s, v) => s + v.x, 0) / n,
    y: face.verts.reduce((s, v) => s + v.y, 0) / n,
  };
}

// 選んだ部分以外の分割をやめて、面の一覧を作る
function assemble(state, pieces, moving) {
  const movedSrc = new Set([...moving].map((p) => p.src));
  const keep = [];
  const handled = new Set();
  for (const p of pieces) {
    if (moving.has(p)) continue;
    if (p.split && !movedSrc.has(p.src)) {
      if (handled.has(p.src)) continue;
      handled.add(p.src);
      keep.push({ ...state.faces[p.src], verts: state.faces[p.src].verts.map((v) => ({ ...v })), moves: [...state.faces[p.src].moves] });
    } else {
      keep.push({ ...p.face, verts: p.face.verts.map((v) => ({ ...v })), moves: [...p.face.moves], id: p.split ? null : p.face.id });
    }
  }
  return keep;
}

function finish(state, faces, newSteps) {
  let nextId = state.nextId;
  for (const f of faces) if (f.id === null || f.id === undefined) f.id = nextId++;
  normalizeLayers(faces);
  stampHistory(state.faces, faces, state.steps.length, newSteps.length);
  return { state: { ...state, faces, steps: [...state.steps.map((s) => ({ ...s })), ...newSteps], nextId } };
}

const stepFor = (line, k, extra) => ({
  kind: 'fold', p: { ...line.p }, d: { ...line.d }, k, angle: 180, ...extra,
});

/**
 * 袋を開いてつぶす（つぶし折り）。
 * line: 袋（2 枚重なったフラップ）のつけ根の線。side: 袋のある側。pick: 袋の上の点。
 * 袋の背（2 枚をつなぐ折り目）が、つけ根の線の上に来るように開いてつぶす。
 */
export function squash(state, { line, side, pick }) {
  if (!line) return { error: '線が短すぎます' };
  const pieces = splitAll(state, line);
  const candidates = pieces.filter((p) => p.side === side);
  const sel = selectComponent(candidates, pick, { excludeLine: line });
  if (sel.error) return sel;
  const flap = [...sel.set];
  const up1 = isFrontUp(sel.seed.face);
  const L1 = flap.filter((p) => isFrontUp(p.face) === up1); // 上の 1 枚（反対側へ開く）
  const L2 = flap.filter((p) => isFrontUp(p.face) !== up1); // 下の 1 枚（その場に残る）
  if (!L2.length) return { error: '袋になっていません（2 枚が折り目でつながった部分を選んでください）' };

  // 袋の背（L1 と L2 をつなぐ折り目）
  let spine = null;
  for (const a of L1) {
    for (const b of L2) {
      const e = sharedEdge(a.face, b.face);
      if (e && !(onLine(line, e[0]) && onLine(line, e[1]))) { spine = e; break; }
    }
    if (spine) break;
  }
  if (!spine) return { error: '袋の背（2 枚をつなぐ折り目）が見つかりません' };
  const spineLine = makeLine(spine[0], spine[1]);
  const O = lineIntersect(spineLine, line);
  if (!O) return { error: '袋の背とつけ根が平行なので、つぶせません' };
  const far = Math.hypot(spine[0].x - O.x, spine[0].y - O.y) > Math.hypot(spine[1].x - O.x, spine[1].y - O.y) ? spine[0] : spine[1];
  const sl = Math.hypot(far.x - O.x, far.y - O.y);
  const s = { x: (far.x - O.x) / sl, y: (far.y - O.y) / sl };
  // 袋の内側の角（背とつけ根の間）を二等分する線
  const c = flap.reduce((acc, p) => { const q = centroid(p.face); return { x: acc.x + q.x, y: acc.y + q.y }; }, { x: 0, y: 0 });
  c.x = c.x / flap.length - O.x; c.y = c.y / flap.length - O.y;
  let d = null;
  for (const sg of [1, -1]) {
    const dd = { x: line.d.x * sg, y: line.d.y * sg };
    const w = cross2(s.x, s.y, dd.x, dd.y);
    if (Math.abs(w) < 1e-9) continue;
    if (Math.sign(cross2(s.x, s.y, c.x, c.y)) === Math.sign(w) && Math.sign(cross2(c.x, c.y, dd.x, dd.y)) === Math.sign(w)) d = dd;
  }
  if (!d) return { error: '袋の向きがわかりません' };
  const bl = Math.hypot(s.x + d.x, s.y + d.y);
  if (bl < 1e-6) return { error: 'この袋はつぶせません' };
  const bis = { p: O, d: { x: (s.x + d.x) / bl, y: (s.y + d.y) / bl } };
  const spineSide = Math.sign(sideOf(bis, { x: O.x + s.x, y: O.y + s.y }));

  const base = state.steps.length;
  const iA = base; // 下の 1 枚の背側を二等分線で折る
  const iB = base + 1; // 上の 1 枚の背側を二等分線で折る
  const iC = base + 2; // 上の 1 枚をつけ根で反対側へ
  const faces = assemble(state, pieces, sel.set);
  const maxAll = Math.max(...state.faces.map((f) => f.layer));
  const lay = (arr) => ({ max: Math.max(...arr.map((p) => p.face.layer)) });
  const m1 = lay(L1).max;
  const m2 = lay(L2).max;
  for (const p of flap) {
    const inL1 = L1.includes(p);
    const { pos, neg } = splitFace(p.face, bis);
    for (const [part, sgn] of [[pos, 1], [neg, -1]]) {
      if (!part) continue;
      const isSpine = sgn === spineSide;
      let verts = part.verts.map((v) => ({ ...v }));
      const moves = [...p.face.moves];
      let layer = part.layer;
      if (isSpine) {
        verts = reflectVerts(verts, bis);
        moves.push(inL1 ? iB : iA);
      }
      if (inL1) {
        verts = reflectVerts(verts, line);
        moves.push(iC);
        layer = maxAll + (isSpine ? 200 : 100) + (m1 - part.layer);
      } else if (isSpine) {
        layer = maxAll + 300 + (m2 - part.layer);
      }
      faces.push({ id: null, verts, layer, moves });
    }
  }
  const g = `squash-${base}`;
  const steps = [
    stepFor(bis, { x: bis.d.x * spineSide, y: bis.d.y * spineSide }, { type: 'squash', group: g, label: '袋を開いてつぶす' }),
    stepFor(bis, { x: bis.d.x * spineSide, y: bis.d.y * spineSide }, { type: 'squash', group: g }),
    stepFor(line, { x: line.d.x * side, y: line.d.y * side }, { type: 'squash', group: g }),
  ];
  return finish(state, faces, steps);
}

/**
 * 中割り折り（袋の先を、折り線で内側に折り込む）。
 * line: 折り線。side: 折り込む先の側。pick: 袋の上の点。
 */
export function reverseFold(state, { line, side, pick }) {
  if (!line) return { error: '線が短すぎます' };
  const pieces = splitAll(state, line);
  const candidates = pieces.filter((p) => p.side === side);
  const sel = selectComponent(candidates, pick, { excludeLine: line });
  if (sel.error) return sel;
  const flap = [...sel.set];
  // 重なり順で、手前の半分（G1）と奥の半分（G2）に分ける
  const byLayer = [...flap].sort((a, b) => b.face.layer - a.face.layer);
  const layersDesc = [...new Set(byLayer.map((p) => p.face.layer))];
  const half = Math.ceil(layersDesc.length / 2);
  const topLayers = new Set(layersDesc.slice(0, half));
  const G1 = flap.filter((p) => topLayers.has(p.face.layer));
  const G2 = flap.filter((p) => !topLayers.has(p.face.layer));
  if (!G2.length || flap.every((p) => isFrontUp(p.face) === isFrontUp(flap[0].face))) {
    return { error: '中割り折りには、2 枚以上が折り目でつながった部分（袋）を選んでください' };
  }
  // 折り線の反対側で、それぞれとつながっている紙の重なり位置
  const stay = pieces.filter((p) => !sel.set.has(p));
  const partnerLayer = (group, pickMax) => {
    const ls = [];
    for (const p of group) for (const q of stay) if (sharedEdge(p.face, q.face)) ls.push(q.face.layer);
    if (!ls.length) return null;
    return pickMax ? Math.max(...ls) : Math.min(...ls);
  };
  const top = partnerLayer(G1, false);
  const bot = partnerLayer(G2, true);
  if (top === null || bot === null) return { error: '折り線の反対側とつながっていません。袋の途中に線を引いてください' };
  if (top <= bot) return { error: 'この向きでは中割り折りできません' };
  const base = state.steps.length;
  const faces = assemble(state, pieces, sel.set);
  const n = flap.length + 2;
  const min1 = Math.min(...G1.map((p) => p.face.layer));
  const max2 = Math.max(...G2.map((p) => p.face.layer));
  for (const p of flap) {
    const inG1 = G1.includes(p);
    const f = p.face;
    // 折り込んだ部分は入れ子になる：内側の紙の部分ほど、真ん中の近くに入る
    const layer = inG1
      ? top - (1 + (f.layer - min1)) / (2 * n)
      : bot + (1 + (max2 - f.layer)) / (2 * n);
    faces.push({ id: null, verts: reflectVerts(f.verts, line), layer, moves: [...f.moves, inG1 ? base : base + 1] });
  }
  const g = `reverse-${base}`;
  const steps = [
    stepFor(line, { x: -line.d.x * side, y: -line.d.y * side }, { type: 'reverse', group: g, label: '中割り折り' }),
    stepFor(line, { x: line.d.x * side, y: line.d.y * side }, { type: 'reverse', group: g }),
  ];
  const r = finish(state, faces, steps);
  if (checkConnectivity(r.state, 2e-3).length) return { error: 'この位置では中割り折りできません（紙が破れてしまいます）' };
  return r;
}

/**
 * 花弁折り。
 * line: 花弁の付け根になる横の線（両端が袋の左右のふちに乗るように引く）。
 * side: 持ち上げる側。pick: 持ち上げる 1 枚の上の点。
 * 1 枚目の真ん中を線で持ち上げ、左右はカイト線で内側に折り込む。
 * 1 枚目と折り目でつながっている下の紙も、カイト線で内側に折れる。
 */
export function petalFold(state, opts) {
  const { line, side, pick } = opts;
  if (!line) return { error: '線が短すぎます' };
  // 正しい花弁の線（カイト線がふちに当たる 2 点を結ぶ線）を求め、引いた線が近ければそちらを使う
  if (!opts.exact) {
    const ideal = idealPetalLine(state, line, side, pick);
    if (ideal) {
      const near = Math.max(Math.abs(sideOf(line, ideal.a)), Math.abs(sideOf(line, ideal.b)));
      if (near < 0.15) {
        const l2 = makeLine(ideal.a, ideal.b);
        // 向きを引いた線にそろえる（side の符号を保つため）
        if (l2.d.x * line.d.x + l2.d.y * line.d.y < 0) { l2.d.x *= -1; l2.d.y *= -1; }
        return petalFold(state, { ...opts, line: l2, exact: true });
      }
    }
  }
  return petalCore(state, { line, side, pick });
}

// 選んだ 1 枚（袋の 1 枚目）について、角 O から出るカイト線がふちに当たる 2 点を求める
function idealPetalLine(state, line, side, pick) {
  const pieces = splitAll(state, line);
  const candidates = pieces.filter((p) => p.side === side);
  const sel = selectComponent(candidates, pick, { excludeLine: line, flatOnly: true });
  if (sel.error) return null;
  const F = [...sel.set];
  let O = null;
  let far = -1;
  for (const p of F) for (const v of p.face.verts) { const d = Math.abs(sideOf(line, v)); if (d > far) { far = d; O = v; } }
  if (!O) return null;
  // 1 枚目の面（分ける前）と、その外周の辺
  const src = [...new Set(F.map((p) => state.faces[p.src]))];
  const edges = [];
  for (const f of src) {
    const vs = f.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      const inner = src.some((g) => g !== f && g.verts.some((c, j) => edgesOverlapUV(a, b, c, g.verts[(j + 1) % g.verts.length])));
      if (!inner) edges.push([a, b]);
    }
  }
  const same = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-7;
  const atO = edges.filter(([a, b]) => same(a, O) || same(b, O)).map(([a, b]) => (same(a, O) ? b : a));
  if (atO.length !== 2) return null;
  const unit = (q) => { const dx = q.x - O.x, dy = q.y - O.y, L = Math.hypot(dx, dy); return { x: dx / L, y: dy / L }; };
  const e1 = unit(atO[0]);
  const e2 = unit(atO[1]);
  const cl = Math.hypot(e1.x + e2.x, e1.y + e2.y);
  if (cl < 1e-9) return null;
  const c = { x: (e1.x + e2.x) / cl, y: (e1.y + e2.y) / cl };
  const hit = (e) => {
    const kl = Math.hypot(e.x + c.x, e.y + c.y);
    const d = { x: (e.x + c.x) / kl, y: (e.y + c.y) / kl };
    let best = null;
    for (const [a, b] of edges) {
      if (same(a, O) || same(b, O)) continue;
      const sx = b.x - a.x, sy = b.y - a.y;
      const den = cross2(d.x, d.y, sx, sy);
      if (Math.abs(den) < 1e-12) continue;
      const t = cross2(a.x - O.x, a.y - O.y, sx, sy) / den;
      const u = cross2(a.x - O.x, a.y - O.y, d.x, d.y) / den;
      if (t > 1e-6 && u > -1e-9 && u < 1 + 1e-9 && (!best || t < best.t)) best = { t, x: O.x + d.x * t, y: O.y + d.y * t };
    }
    return best;
  };
  const a = hit(e1);
  const b = hit(e2);
  return a && b ? { a, b } : null;
}

function petalCore(state, { line, side, pick }) {
  const pieces = splitAll(state, line);
  const candidates = pieces.filter((p) => p.side === side);
  const sel = selectComponent(candidates, pick, { excludeLine: line, flatOnly: true });
  if (sel.error) return sel;
  const F = [...sel.set];
  // 持ち上げる角（線から一番遠い点）と、線と 1 枚目のふちの交点
  let O = null;
  let far = -1;
  let tmin = Infinity;
  let tmax = -Infinity;
  for (const p of F) {
    for (const v of p.face.verts) {
      const d = Math.abs(sideOf(line, v));
      if (d > far) { far = d; O = v; }
      if (d < 1e-7) {
        const t = (v.x - line.p.x) * line.d.x + (v.y - line.p.y) * line.d.y;
        tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
      }
    }
  }
  if (!O || tmax - tmin < 1e-6) return { error: '花弁折りの線が、選んだ紙を横切っていません' };
  const KL = { x: line.p.x + line.d.x * tmin, y: line.p.y + line.d.y * tmin };
  const KR = { x: line.p.x + line.d.x * tmax, y: line.p.y + line.d.y * tmax };
  const kites = [makeLine(O, KL), makeLine(O, KR)];
  if (!kites[0] || !kites[1]) return { error: '花弁折りの形になっていません' };
  // それぞれのカイト線について、O から見て「外側」の符号
  const outer = kites.map((k, i) => Math.sign(sideOf(k, i === 0 ? KR : KL)) * -1);

  const base = state.steps.length;
  const iK = [base, base + 1];
  const iH = base + 2;
  const maxAll = Math.max(...state.faces.map((f) => f.layer));
  const moving = new Set(F);
  const out = [];
  const pushPart = (part, moves, layer, verts) => out.push({ id: null, verts, layer, moves });

  // 1 枚目：真ん中は線で、左右はカイト線で折ってから線で
  const maxF = Math.max(...F.map((p) => p.face.layer));
  for (const p of F) {
    let parts = [{ face: p.face, kite: -1 }];
    for (let i = 0; i < 2; i++) {
      const next = [];
      for (const q of parts) {
        if (q.kite >= 0) { next.push(q); continue; }
        const { pos, neg } = splitFace(q.face, kites[i]);
        if (pos) next.push({ face: pos, kite: outer[i] === 1 ? i : -1 });
        if (neg) next.push({ face: neg, kite: outer[i] === -1 ? i : -1 });
      }
      parts = next;
    }
    for (const q of parts) {
      let verts = q.face.verts.map((v) => ({ ...v }));
      const moves = [...p.face.moves];
      if (q.kite >= 0) { verts = reflectVerts(verts, kites[q.kite]); moves.push(iK[q.kite]); }
      verts = reflectVerts(verts, line);
      moves.push(iH);
      // 左右は真ん中の後ろに回り込み、持ち上げると真ん中の前に来る
      const layer = maxAll + (q.kite >= 0 ? 200 : 100) + (maxF - p.face.layer);
      pushPart(q, moves, layer, verts);
    }
  }
  // 1 枚目と、ふち（折り目）でつながっている下の紙のカイト部分
  const partners = [];
  for (const c of candidates) {
    if (moving.has(c)) continue;
    for (const p of F) {
      const e = sharedEdge(p.face, c.face);
      if (!e) continue;
      if (onLine(line, e[0]) && onLine(line, e[1])) continue;
      if (kites.some((k) => onLine(k, e[0]) && onLine(k, e[1]))) continue;
      partners.push(c);
      break;
    }
  }
  const partnerParts = [];
  for (const c of partners) {
    moving.add(c);
    // どちら側のカイト線に近いか
    const cc = centroid(c.face);
    const i = Math.abs(sideOf(kites[0], cc)) < Math.abs(sideOf(kites[1], cc)) ? 0 : 1;
    const { pos, neg } = splitFace(c.face, kites[i]);
    for (const [part, sg] of [[pos, 1], [neg, -1]]) {
      if (!part) continue;
      if (sg === outer[i]) {
        partnerParts.push({ part, i, c });
      } else {
        out.push({ id: null, verts: part.verts.map((v) => ({ ...v })), layer: part.layer, moves: [...c.face.moves] });
      }
    }
  }
  const maxP = partnerParts.length ? Math.max(...partnerParts.map((q) => q.c.face.layer)) : 0;
  for (const q of partnerParts) {
    out.push({
      id: null,
      verts: reflectVerts(q.part.verts, kites[q.i]),
      layer: maxAll + 50 + (maxP - q.c.face.layer),
      moves: [...q.c.face.moves, iK[q.i]],
    });
  }
  const faces = [...assemble(state, pieces, moving), ...out];
  const g = `petal-${base}`;
  const kStep = (i) => {
    const sd = -outer[i]; // 左右は奥へ回り込む
    return stepFor(kites[i], { x: kites[i].d.x * sd, y: kites[i].d.y * sd }, { type: 'petal', group: g });
  };
  const steps = [
    { ...kStep(0), label: '花弁折り' },
    kStep(1),
    stepFor(line, { x: line.d.x * side, y: line.d.y * side }, { type: 'petal', group: g }),
  ];
  const r = finish(state, faces, steps);
  // 手で引いた線は少しずれるので、目に見えない程度のずれは許す
  if (checkConnectivity(r.state, 2e-3).length) {
    return { error: 'この線では花弁折りできません。袋の左右のふちの、カイト線が当たる点どうしを結んでください', torn: r.state };
  }
  return r;
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
  stampHistory(state.faces, faces, state.steps.length, 1);
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
  stampHistory(state.faces, faces, state.steps.length, 1);
  return { state: { ...state, faces, steps: [...state.steps.map((s) => ({ ...s })), step] } };
}

// ---------------------------------------------------------------- 検査

// 紙が破れていないか：展開図で隣り合う面どうしは、平らな状態でも同じ所でつながっているはず。
// つながっていない組を返す（空なら正しい）
export function checkConnectivity(state, tol = 1e-6) {
  const bad = [];
  const fs = state.faces;
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const e = sharedEdge(fs[i], fs[j]);
      if (!e) continue;
      // e は fs[i] の辺。その両端（展開図上の点）が fs[j] で同じ xy にあるか
      const mapJ = faceAffine(fs[j], fs[j].verts.map((v) => [v.x, v.y]));
      const ov = overlapUV(fs[i], fs[j], e);
      for (const t of [ov[0], ov[1]]) {
        const u = e[0].u + (e[1].u - e[0].u) * t;
        const v = e[0].v + (e[1].v - e[0].v) * t;
        const pi = { x: e[0].x + (e[1].x - e[0].x) * t, y: e[0].y + (e[1].y - e[0].y) * t };
        const [x, y] = mapJ(u, v);
        if (Math.hypot(x - pi.x, y - pi.y) > tol) { bad.push([fs[i].id, fs[j].id]); break; }
      }
    }
  }
  return bad;
}

function overlapUV(fa, fb, [a, b]) {
  const ex = b.u - a.u;
  const ey = b.v - a.v;
  const len2 = ex * ex + ey * ey;
  const B = fb.verts;
  for (let j = 0; j < B.length; j++) {
    const c = B[j];
    const d = B[(j + 1) % B.length];
    if (!edgesOverlapUV(a, b, c, d)) continue;
    const tc = ((c.u - a.u) * ex + (c.v - a.v) * ey) / len2;
    const td = ((d.u - a.u) * ex + (d.v - a.v) * ey) / len2;
    return [Math.max(0, Math.min(tc, td)), Math.min(1, Math.max(tc, td))];
  }
  return [0, 1];
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
  // 半分以上折れている最後の手順までを「折った」とみなし、その時点の重なり順で描く
  let done = 0;
  steps.forEach((st, i) => {
    const a = angles ? angles[i] : st.angle;
    const full = st.kind === 'rotate' ? st.full : 180;
    if (Math.abs(a) >= Math.abs(full) / 2) done = i + 1;
  });
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
      P[2] += (face.hist?.[done] ?? face.layer) * LAYER_GAP;
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
