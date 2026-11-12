// 展開図から折り目に沿って折る物理シミュレーション
//
// 紙を三角形メッシュにして、
//   - 辺の長さを保つばね（伸び縮みしない紙）
//   - 折り線の二面角を目標角度に近づけるねじりばね
//   - 折り線でない辺（面の中）は平らに保つねじりばね
// を同時に解く（Origami Simulator [Ghassaei et al. 2018] と同じ考え方を CPU で実装）。

// ---------------------------------------------------------------- 三角形分割（耳切り法）

function triangulate(poly, P) {
  const idx = [...poly];
  const tris = [];
  const area2 = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  const inside = (p, a, b, c) => area2(a, b, p) > 0 && area2(b, c, p) > 0 && area2(c, a, p) > 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (area2(a, b, c) <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push(idx);
  return tris;
}

// ---------------------------------------------------------------- モデルの構築

/**
 * cp: { vertices: [[u,v]], edges: [[i, j, 'M'|'V'|'F'|'B', frac]], faces: [[i...]] }
 * u, v は -1..1。size は紙の 1 辺の長さ。
 */
// 辺の一覧から面（反時計回りの多角形）を求める
export function facesFromEdges(vertices, edges) {
  const nbr = vertices.map(() => []);
  for (const [i, j] of edges) { nbr[i].push(j); nbr[j].push(i); }
  const ang = (a, b) => Math.atan2(vertices[b][1] - vertices[a][1], vertices[b][0] - vertices[a][0]);
  nbr.forEach((list, v) => list.sort((p, q) => ang(v, p) - ang(v, q)));
  const used = new Set();
  const faces = [];
  for (const [i, j] of edges) {
    for (const [s0, t0] of [[i, j], [j, i]]) {
      if (used.has(`${s0},${t0}`)) continue;
      const face = [];
      let s = s0;
      let t = t0;
      for (let guard = 0; guard < 1000; guard++) {
        used.add(`${s},${t}`);
        face.push(s);
        const list = nbr[t];
        const next = list[(list.indexOf(s) - 1 + list.length) % list.length];
        s = t; t = next;
        if (s === s0 && t === t0) break;
      }
      let area = 0;
      for (let k = 0; k < face.length; k++) {
        const p = vertices[face[k]];
        const q = vertices[face[(k + 1) % face.length]];
        area += p[0] * q[1] - q[0] * p[1];
      }
      if (area > 1e-9) faces.push(face);
    }
  }
  return faces;
}

export function buildModel(cp, size = 2) {
  const s = size / 2;
  const uv = cp.vertices.map(([u, v]) => [u, v]);
  const n = uv.length;
  const faces = cp.faces ?? facesFromEdges(cp.vertices, cp.edges);
  const tris = faces.flatMap((f) => triangulate(f, uv));

  const edgeInfo = new Map();
  const key = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
  for (const [i, j, type, frac] of cp.edges) edgeInfo.set(key(i, j), { type, frac });

  // 辺ごとに隣り合う三角形を集める
  const adj = new Map();
  tris.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const c = t[(k + 2) % 3];
      const kk = key(a, b);
      if (!adj.has(kk)) adj.set(kk, []);
      adj.get(kk).push({ a, b, c, ti });
    }
  });

  const bars = [];
  const hinges = [];
  for (const [kk, list] of adj) {
    const [i, j] = kk.split(',').map(Number);
    const l0 = Math.hypot(uv[i][0] - uv[j][0], uv[i][1] - uv[j][1]) * s;
    bars.push({ i, j, l0 });
    if (list.length !== 2) continue;
    const info = edgeInfo.get(kk) ?? { type: 'F', frac: 0 };
    // 三角形 1 で a→b の向き（反時計回り）になる方を基準にする
    const t1 = list[0];
    const t2 = list[1];
    const sign = info.type === 'V' ? 1 : info.type === 'M' ? -1 : 0;
    hinges.push({
      a: t1.a, b: t1.b, c: t1.c, d: t2.c,
      target: sign * Math.PI * (info.frac ?? 1),
      crease: sign !== 0,
      l0,
    });
  }

  return {
    n,
    uv,
    tris,
    bars,
    hinges,
    creaseLines: cp.edges.filter((e) => e[2] === 'M' || e[2] === 'V'),
    size,
  };
}

// ---------------------------------------------------------------- 二面角とその勾配

const sub = (p, i, j, out) => {
  out[0] = p[3 * i] - p[3 * j];
  out[1] = p[3 * i + 1] - p[3 * j + 1];
  out[2] = p[3 * i + 2] - p[3 * j + 2];
  return out;
};
const cross = (a, b, out) => {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const E = [0, 0, 0], AC = [0, 0, 0], AD = [0, 0, 0], N1 = [0, 0, 0], N2 = [0, 0, 0], X = [0, 0, 0];

/**
 * 辺 a-b を共有する三角形 (a,b,c) と (b,a,d) の折り角。
 * 0 = 平ら、正 = 谷折り（表側どうしが近づく）、負 = 山折り。
 * grad を渡すと、各頂点についての勾配 [ga, gb, gc, gd]（各 3 要素）を書き込む。
 */
export function dihedral(pos, h, grad) {
  sub(pos, h.b, h.a, E);
  sub(pos, h.c, h.a, AC);
  sub(pos, h.d, h.a, AD);
  cross(E, AC, N1); // 三角形 1 の法線（表向き）
  cross(AD, E, N2); // 三角形 2 の法線（表向き）
  const el = Math.sqrt(dot(E, E));
  const n1l2 = dot(N1, N1);
  const n2l2 = dot(N2, N2);
  if (el < 1e-12 || n1l2 < 1e-24 || n2l2 < 1e-24) return 0;
  cross(N1, N2, X);
  const sinT = dot(X, E) / (el * Math.sqrt(n1l2 * n2l2));
  const cosT = dot(N1, N2) / Math.sqrt(n1l2 * n2l2);
  // 谷折りで正になるように符号を合わせる
  const theta = -Math.atan2(sinT, cosT);
  if (grad) {
    // d の勾配: 三角形 2 の法線方向 / 高さ、c も同様（符号は数値微分で確認済み）
    const gc = grad[2], gd = grad[3], ga = grad[0], gb = grad[1];
    const kc = el / n1l2;
    const kd = el / n2l2;
    for (let q = 0; q < 3; q++) {
      gc[q] = N1[q] * kc;
      gd[q] = N2[q] * kd;
    }
    const tc = dot(AC, E) / (el * el);
    const td = dot(AD, E) / (el * el);
    for (let q = 0; q < 3; q++) {
      ga[q] = -(1 - tc) * gc[q] - (1 - td) * gd[q];
      gb[q] = -tc * gc[q] - td * gd[q];
    }
  }
  return theta;
}

// ---------------------------------------------------------------- シミュレーター

export class FoldSim {
  constructor(model, opts = {}) {
    this.m = model;
    const n = model.n;
    const s = model.size / 2;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.force = new Float64Array(3 * n);
    model.uv.forEach(([u, v], i) => {
      this.pos[3 * i] = u * s;
      this.pos[3 * i + 1] = v * s;
      this.pos[3 * i + 2] = 0;
    });
    this.axial = opts.axial ?? 20;
    this.creaseK = opts.crease ?? 0.7;
    this.facetK = opts.facet ?? 0.7;
    this.damping = opts.damping ?? 0.45;
    this.percent = 0;
    this.grad = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    // 安定な時間刻み
    // （細い三角形では折り線のばねの方が硬くなるので、それも考える）
    let kmax = 0;
    for (const b of model.bars) kmax = Math.max(kmax, this.axial / b.l0);
    const P = model.uv.map(([u, v]) => [u * s, v * s]);
    const height = (a, b, c) => {
      const ex = P[b][0] - P[a][0], ey = P[b][1] - P[a][1];
      const L = Math.hypot(ex, ey) || 1e-9;
      return Math.abs(ex * (P[c][1] - P[a][1]) - ey * (P[c][0] - P[a][0])) / L;
    };
    for (const h of model.hinges) {
      const k = Math.max(this.creaseK, this.facetK) * h.l0;
      const hmin = Math.max(1e-4, Math.min(height(h.a, h.b, h.c), height(h.a, h.b, h.d)));
      kmax = Math.max(kmax, (2 * k) / (hmin * hmin));
    }
    this.dt = 1 / (2 * Math.PI * Math.sqrt(kmax));
    // 重心近くの頂点を基準にして、全体がふらふら動かないようにする
    this.anchor = this.findAnchor();
  }

  findAnchor() {
    // 紙の中心に最も近い三角形
    let best = 0;
    let bd = Infinity;
    this.m.tris.forEach((t, i) => {
      const cx = (this.m.uv[t[0]][0] + this.m.uv[t[1]][0] + this.m.uv[t[2]][0]) / 3;
      const cy = (this.m.uv[t[0]][1] + this.m.uv[t[1]][1] + this.m.uv[t[2]][1]) / 3;
      const d = Math.hypot(cx, cy);
      if (d < bd) { bd = d; best = i; }
    });
    return this.m.tris[best];
  }

  reset() {
    const s = this.m.size / 2;
    this.m.uv.forEach(([u, v], i) => {
      this.pos[3 * i] = u * s;
      this.pos[3 * i + 1] = v * s;
      this.pos[3 * i + 2] = 0;
    });
    this.vel.fill(0);
    for (const h of this.m.hinges) delete h.last;
  }

  step(iterations = 1) {
    const { pos, vel, force } = this;
    const m = this.m;
    const dt = this.dt;
    const g = this.grad;
    for (let it = 0; it < iterations; it++) {
      force.fill(0);
      // 長さのばね（減衰つき）
      for (const b of m.bars) {
        const i3 = 3 * b.i;
        const j3 = 3 * b.j;
        const dx = pos[j3] - pos[i3];
        const dy = pos[j3 + 1] - pos[i3 + 1];
        const dz = pos[j3 + 2] - pos[i3 + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
        const k = this.axial / b.l0;
        const c = 2 * this.damping * Math.sqrt(k);
        const ux = dx / l, uy = dy / l, uz = dz / l;
        const rv = (vel[j3] - vel[i3]) * ux + (vel[j3 + 1] - vel[i3 + 1]) * uy + (vel[j3 + 2] - vel[i3 + 2]) * uz;
        const f = k * (l - b.l0) + c * rv;
        force[i3] += f * ux; force[i3 + 1] += f * uy; force[i3 + 2] += f * uz;
        force[j3] -= f * ux; force[j3 + 1] -= f * uy; force[j3 + 2] -= f * uz;
      }
      // 折り線・面のねじりばね
      for (const h of m.hinges) {
        let theta = dihedral(pos, h, g);
        // ±180° をまたいだときに角度が飛ばないように、前回の値からつなげる
        if (h.last !== undefined) {
          while (theta - h.last > Math.PI) theta -= 2 * Math.PI;
          while (theta - h.last < -Math.PI) theta += 2 * Math.PI;
        }
        h.last = theta;
        const target = h.crease ? h.target * this.percent : 0;
        const k = (h.crease ? this.creaseK : this.facetK) * h.l0;
        const f = -k * (theta - target);
        const vs = [h.a, h.b, h.c, h.d];
        for (let q = 0; q < 4; q++) {
          const v3 = 3 * vs[q];
          force[v3] += f * g[q][0];
          force[v3 + 1] += f * g[q][1];
          force[v3 + 2] += f * g[q][2];
        }
      }
      // 速度・位置の更新（全体にも少し減衰）
      for (let i = 0; i < pos.length; i++) {
        vel[i] = (vel[i] + force[i] * dt) * 0.995;
        pos[i] += vel[i] * dt;
      }
    }
    this.pinAnchor();
  }

  // 基準の三角形が元の場所・向きにとどまるように、全体を剛体変換で戻す
  pinAnchor() {
    const [a, b, c] = this.anchor;
    const P = (i) => [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]];
    const s = this.m.size / 2;
    const Q = (i) => [this.m.uv[i][0] * s, this.m.uv[i][1] * s, 0];
    const frame = (p0, p1, p2) => {
      const ex = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
      const t = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const ez = norm(crs(ex, t));
      const ey = crs(ez, ex);
      return [ex, ey, ez];
    };
    const pa = P(a), pb = P(b), pc = P(c);
    const qa = Q(a), qb = Q(b), qc = Q(c);
    const F = frame(pa, pb, pc);
    const G = frame(qa, qb, qc);
    const cp = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    const cq = [(qa[0] + qb[0] + qc[0]) / 3, (qa[1] + qb[1] + qc[1]) / 3, 0];
    // R = G^T F（F の座標系 → G の座標系）
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((col) => G[0][r] * F[0][col] + G[1][r] * F[1][col] + G[2][r] * F[2][col]));
    const tr = (v) => [
      R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
      R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
      R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
    ];
    for (let i = 0; i < this.m.n; i++) {
      const p = tr([this.pos[3 * i] - cp[0], this.pos[3 * i + 1] - cp[1], this.pos[3 * i + 2] - cp[2]]);
      this.pos[3 * i] = p[0] + cq[0];
      this.pos[3 * i + 1] = p[1] + cq[1];
      this.pos[3 * i + 2] = p[2] + cq[2];
      const v = tr([this.vel[3 * i], this.vel[3 * i + 1], this.vel[3 * i + 2]]);
      this.vel[3 * i] = v[0]; this.vel[3 * i + 1] = v[1]; this.vel[3 * i + 2] = v[2];
    }
  }

  // 折り線の角度が目標にどれだけ近いか（0..1、1 = 目標どおり）
  error() {
    let sum = 0;
    let cnt = 0;
    for (const h of this.m.hinges) {
      if (!h.crease) continue;
      sum += Math.abs((h.last ?? dihedral(this.pos, h)) - h.target * this.percent);
      cnt++;
    }
    return cnt ? sum / cnt : 0;
  }
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function crs(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
