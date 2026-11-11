// 展開図 SVG（Origami Simulator 形式）を、頂点・辺・面のデータに変換する
//   青 = 谷折り、赤 = 山折り、黄 = 面の分割線（平ら）、黒 = 紙のふち
//   opacity = 折る角度の割合（1 = 180°）
// 使い方: node tools/svg-to-cp.mjs tools/traditionalCrane.svg crane > js/data/crane-cp.js
import { readFileSync } from 'node:fs';

const [, , file, name = 'cp'] = process.argv;
const svg = readFileSync(file, 'utf8');
const attr = (tag, a) => {
  const m = tag.match(new RegExp(`\\s${a}="([^"]*)"`));
  return m ? m[1] : null;
};

const rectTag = svg.match(/<rect[^>]*>/)[0];
const rx = +attr(rectTag, 'x'), ry = +attr(rectTag, 'y');
const rw = +attr(rectTag, 'width'), rh = +attr(rectTag, 'height');
const norm = (x, y) => [((x - rx) / rw) * 2 - 1, -(((y - ry) / rh) * 2 - 1)];

const TYPE = { '#0000FF': 'V', '#FF0000': 'M', '#FFFF00': 'F', '#000000': 'B' };
const segs = [];
for (const tag of svg.match(/<line[^>]*>/g)) {
  const type = TYPE[attr(tag, 'stroke').toUpperCase()];
  if (!type) continue;
  const a = norm(+attr(tag, 'x1'), +attr(tag, 'y1'));
  const b = norm(+attr(tag, 'x2'), +attr(tag, 'y2'));
  const op = attr(tag, 'opacity');
  segs.push({ a, b, type, frac: op === null ? 1 : +op });
}
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
for (let i = 0; i < 4; i++) segs.push({ a: corners[i], b: corners[(i + 1) % 4], type: 'B', frac: 0 });

// 頂点をまとめる
const TOL = 5e-3;
const verts = [];
const vid = (p) => {
  for (let i = 0; i < verts.length; i++) {
    if (Math.hypot(verts[i][0] - p[0], verts[i][1] - p[1]) < TOL) return i;
  }
  verts.push([p[0], p[1]]);
  return verts.length - 1;
};
for (const s of segs) { s.ia = vid(s.a); s.ib = vid(s.b); }

// 交点を頂点として追加
for (let i = 0; i < segs.length; i++) {
  for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i].a, r = [segs[i].b[0] - p[0], segs[i].b[1] - p[1]];
    const q = segs[j].a, s = [segs[j].b[0] - q[0], segs[j].b[1] - q[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) continue;
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
    const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
    const e = 1e-6;
    if (t > e && t < 1 - e && u > -e && u < 1 + e) vid([p[0] + t * r[0], p[1] + t * r[1]]);
    else if (u > e && u < 1 - e && t > -e && t < 1 + e) vid([p[0] + t * r[0], p[1] + t * r[1]]);
  }
}

// 線分を、その上にある頂点で分割して辺にする
const edges = new Map();
for (const s of segs) {
  const [ax, ay] = verts[s.ia], [bx, by] = verts[s.ib];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  const on = [];
  verts.forEach(([x, y], i) => {
    const t = ((x - ax) * dx + (y - ay) * dy) / (len * len);
    const dist = Math.abs((x - ax) * dy - (y - ay) * dx) / len;
    if (dist < TOL && t > -1e-6 && t < 1 + 1e-6) on.push([t, i]);
  });
  on.sort((p, q) => p[0] - q[0]);
  for (let k = 0; k + 1 < on.length; k++) {
    const i = on[k][1], j = on[k + 1][1];
    if (i === j) continue;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    const prev = edges.get(key);
    if (!prev || prev.type === 'F') edges.set(key, { i: Math.min(i, j), j: Math.max(i, j), type: s.type, frac: s.frac });
  }
}

// 面を求める（各頂点で辺を角度順に並べ、左側の面をたどる）
const nbr = verts.map(() => []);
for (const e of edges.values()) { nbr[e.i].push(e.j); nbr[e.j].push(e.i); }
const ang = (a, b) => Math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0]);
nbr.forEach((list, v) => list.sort((p, q) => ang(v, p) - ang(v, q)));
const used = new Set();
const faces = [];
for (const e of edges.values()) {
  for (const [s0, t0] of [[e.i, e.j], [e.j, e.i]]) {
    if (used.has(`${s0},${t0}`)) continue;
    const face = [];
    let s = s0, t = t0;
    for (let guard = 0; guard < 1000; guard++) {
      used.add(`${s},${t}`);
      face.push(s);
      const list = nbr[t];
      const k = list.indexOf(s);
      const next = list[(k - 1 + list.length) % list.length]; // 時計回りに一つ前 → 面を左に見る
      s = t; t = next;
      if (s === s0 && t === t0) break;
    }
    let area = 0;
    for (let k = 0; k < face.length; k++) {
      const p = verts[face[k]], q = verts[face[(k + 1) % face.length]];
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (area > 1e-9) faces.push(face);
  }
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const data = {
  vertices: verts.map(([x, y]) => [r5(x), r5(y)]),
  edges: [...edges.values()].map((e) => [e.i, e.j, e.type, e.frac]),
  faces,
};
const total = faces.reduce((s, f) => {
  let a = 0;
  for (let k = 0; k < f.length; k++) {
    const p = verts[f[k]], q = verts[f[(k + 1) % f.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return s + a / 2;
}, 0);
console.error(`vertices ${verts.length}, edges ${edges.size}, faces ${faces.length}, area ${total.toFixed(6)}`);
console.log(`// ${file.split('/').pop()} から tools/svg-to-cp.mjs で生成。手で編集しないでください。`);
if (/traditionalCrane/.test(file)) {
  console.log('// 元の展開図: Origami Simulator (https://github.com/amandaghassaei/OrigamiSimulator)');
  console.log('// Copyright (c) 2018 Amanda Ghassaei, MIT License（tools/LICENSE-OrigamiSimulator.txt）');
}
console.log(`export const ${name} = ${JSON.stringify(data)};`);
