import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPaper, fold, flip, squash, reverseFold, addCrease, creaseSegmentsXY,
  makeLine, sideOf, bounds, totalArea, poseFaces, selectComponent, overlapArea,
} from '../js/paper.js';

const L = (a, b, c, d) => makeLine({ x: a, y: b }, { x: c, y: d });
const S = (l, x, y) => Math.sign(sideOf(l, { x, y }));
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;

function smallTriangle() {
  let s = createPaper();
  let l = L(-1, 1, 1, -1);
  s = fold(s, { line: l, side: S(l, 1, 1), type: 'valley' }).state;
  l = L(-1, -1, 1, 1);
  return fold(s, { line: l, side: S(l, -0.8, 0.5), type: 'valley' }).state;
}

test('折り筋：折って開くと筋だけ残り、面は分かれない', () => {
  const l = L(0, -1, 0, 1);
  const r = addCrease(createPaper(), { line: l, side: 1 });
  assert.equal(r.state.faces.length, 1);
  assert.equal(r.state.steps.length, 0);
  assert.equal(r.state.creaseMarks.length, 1);
  const segs = creaseSegmentsXY(r.state);
  assert.equal(segs.length, 1);
  assert.ok(close(segs[0].a.x, 0) && close(segs[0].b.x, 0));
});

test('折り筋は、その後に折っても紙といっしょに動く', () => {
  let s = addCrease(createPaper(), { line: L(-1, 0, 1, 0), side: 1 }).state; // 横の筋
  const l = L(0, -1, 0, 1);
  s = fold(s, { line: l, side: S(l, -0.5, 0), type: 'valley' }).state; // 左を右へ
  const segs = creaseSegmentsXY(s);
  assert.equal(segs.length, 2); // 左右それぞれの面に 1 本ずつ
  for (const sg of segs) assert.ok(close(sg.a.y, 0) && close(sg.b.y, 0) && sg.a.x > -1e-9 && sg.b.x > -1e-9);
});

test('袋をつぶす：三角の袋を 2 回つぶすと正方基本形になる', () => {
  const s = smallTriangle();
  const H = L(-1, -1, 0, 0);
  const r1 = squash(s, { line: H, side: S(H, 0.5, -0.5), pick: { x: 0.2, y: -0.7, select: 'top' } });
  assert.equal(r1.error, undefined);
  assert.equal(r1.state.steps.length, 5);
  assert.ok(r1.state.steps.slice(2).every((st) => st.group === r1.state.steps[2].group));
  const f = flip(r1.state).state;
  const H2 = L(1, -1, 0, 0);
  const r2 = squash(f, { line: H2, side: S(H2, -0.5, -0.7), pick: { x: -0.3, y: -0.8, select: 'top' } });
  assert.equal(r2.error, undefined);
  const b = bounds(r2.state);
  assert.ok(close(b.minX, 0, 1e-6) && close(b.maxX, 1, 1e-6) && close(b.minY, -1, 1e-6) && close(b.maxY, 0, 1e-6));
  assert.ok(close(totalArea(r2.state), 4, 1e-6));
  // 角度 0 にすると元の三角に戻る
  const angles = r2.state.steps.map((st) => st.angle);
  for (let i = 2; i < angles.length; i++) angles[i] = r2.state.steps[i].kind === 'rotate' ? 0 : 0;
  const pts = poseFaces(r2.state, angles).flatMap((p) => p.pts);
  assert.ok(pts.every((p) => Math.abs(p[2]) < 0.1));
});

test('袋でない所はつぶせない', () => {
  const H = L(0, -1, 0, 1);
  const r = squash(createPaper(), { line: H, side: 1, pick: { x: 0.5, y: 0, select: 'top' } });
  assert.ok(r.error);
});

test('中割り折り：袋の先が内側（2 枚の間）に入る', () => {
  let s = createPaper();
  const l = L(0, -1, 0, 1);
  s = fold(s, { line: l, side: S(l, -0.5, 0), type: 'valley' }).state;
  const R = L(0, 0.4, 0.6, 1);
  const r = reverseFold(s, { line: R, side: S(R, 0.1, 0.95), pick: { x: 0.1, y: 0.95, select: 'top' } });
  assert.equal(r.error, undefined);
  const moved = r.state.faces.filter((f) => f.moves.some((m) => m >= 1));
  const stay = r.state.faces.filter((f) => !f.moves.some((m) => m >= 1));
  const maxStay = Math.max(...stay.map((f) => f.layer));
  const minStay = Math.min(...stay.map((f) => f.layer));
  for (const f of moved) assert.ok(f.layer < maxStay && f.layer > minStay);
  assert.ok(close(totalArea(r.state), 4, 1e-9));
});

test('上だけ折る：選んだ部分の上に重なった紙も一緒に動かす（突き抜けない）', () => {
  const sq = (x0, y0, x1, y1, layer, id) => ({
    face: { id, layer, moves: [], verts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, u: x + id * 10, v: y })) },
  });
  const A = sq(0, 0, 1, 1, 0, 1);       // 選ぶ紙
  const B = sq(0.5, 0.5, 1.5, 1.5, 1, 2); // A の一部に乗っている別の紙（つながっていない）
  const C = sq(2, 2, 3, 3, 2, 3);       // 離れた紙
  const pick = { x: 0.2, y: 0.2, select: 'top' };
  assert.deepEqual([...selectComponent([A, B, C], pick).set], [A]);
  const withCarry = selectComponent([A, B, C], pick, { carry: 'above' }).set;
  assert.ok(withCarry.has(A) && withCarry.has(B) && !withCarry.has(C));
  assert.ok(overlapArea(A.face, B.face) > 0.24 && overlapArea(A.face, C.face) === 0);
});

test('途中の段階は、その時点の重なり順で描く', () => {
  // 右半分を左へ谷折り（上に乗る）→ 全体を下から上へ谷折り
  let s = createPaper();
  let l = L(0, -1, 0, 1);
  s = fold(s, { line: l, side: S(l, 0.5, 0), type: 'valley' }).state;
  l = L(-1, 0, 1, 0);
  s = fold(s, { line: l, side: S(l, 0, -0.5), type: 'valley' }).state;
  for (const f of s.faces) assert.equal(f.hist.length, 3);
  // 1 手目だけ折った状態：最初に動いた面が上
  const pose = poseFaces(s, [180, 0]);
  const z = (f) => pose.find((p) => p.face === f).pts[0][2];
  const top1 = s.faces.filter((f) => f.moves.includes(0) && !f.moves.includes(1));
  const bottom1 = s.faces.filter((f) => !f.moves.includes(0) && !f.moves.includes(1));
  for (const a of top1) for (const b of bottom1) assert.ok(z(a) > z(b));
});

test('花弁折り ×2 で鳥の基本形になり、外側はすべて同じ色', async () => {
  const { petalFold, rotate, checkConnectivity, isFrontUp, pointInFace } = await import('../js/paper.js');
  let s = flip(createPaper()).state; // 白い面を上に
  let l = L(-1, 1, 1, -1);
  s = fold(s, { line: l, side: S(l, 1, 1), type: 'valley' }).state;
  l = L(-1, -1, 1, 1);
  s = fold(s, { line: l, side: S(l, -0.8, 0.5), type: 'valley' }).state;
  let H = L(-1, -1, 0, 0);
  s = squash(s, { line: H, side: S(H, 0.5, -0.5), pick: { x: 0.2, y: -0.7, select: 'top' } }).state;
  s = flip(s).state;
  H = L(1, -1, 0, 0);
  s = squash(s, { line: H, side: S(H, -0.5, -0.7), pick: { x: -0.3, y: -0.8, select: 'top' } }).state;
  s = rotate(s, -45).state;
  const HY = -0.5 + (1 - Math.SQRT1_2);
  const h = L(0, HY, 1, HY);
  let r = petalFold(s, { line: h, side: S(h, 0.5, -1), pick: { x: 0.5, y: -1, select: 'top' } });
  assert.equal(r.error, undefined);
  s = flip(r.state).state;
  r = petalFold(s, { line: h, side: S(h, 0.5, -1), pick: { x: 0.5, y: -1, select: 'top' } });
  assert.equal(r.error, undefined);
  s = r.state;
  const b = bounds(s);
  assert.ok(close(b.minX, 0.5 - (Math.SQRT2 - 1), 1e-6) && close(b.maxX, 0.5 + (Math.SQRT2 - 1), 1e-6));
  assert.ok(close(b.maxY - b.minY, 2, 1e-6)); // 細長いひし形（高さ 2）
  assert.deepEqual(checkConnectivity(s), []);
  // 表から見ても裏から見ても、見えるのは同じ側の面だけ
  const sides = new Set();
  for (let x = b.minX + 0.01; x < b.maxX; x += 0.03) {
    for (let y = b.minY + 0.01; y < b.maxY; y += 0.03) {
      const under = s.faces.filter((f) => pointInFace(f, { x, y })).sort((a, c) => c.layer - a.layer);
      if (!under.length) continue;
      sides.add(isFrontUp(under[0]) ? 'front' : 'back');
      sides.add(isFrontUp(under[under.length - 1]) ? 'back' : 'front');
    }
  }
  assert.deepEqual([...sides], ['front']);
});

test('花弁折りの線がずれていると、紙が破れるので折らない', async () => {
  const { petalFold, rotate } = await import('../js/paper.js');
  let s = flip(createPaper()).state;
  let l = L(-1, 1, 1, -1); s = fold(s, { line: l, side: S(l, 1, 1), type: 'valley' }).state;
  l = L(-1, -1, 1, 1); s = fold(s, { line: l, side: S(l, -0.8, 0.5), type: 'valley' }).state;
  let H = L(-1, -1, 0, 0); s = squash(s, { line: H, side: S(H, 0.5, -0.5), pick: { x: 0.2, y: -0.7, select: 'top' } }).state;
  s = flip(s).state;
  H = L(1, -1, 0, 0); s = squash(s, { line: H, side: S(H, -0.5, -0.7), pick: { x: -0.3, y: -0.8, select: 'top' } }).state;
  s = rotate(s, -45).state;
  const h = L(0, -0.45, 1, -0.45); // 正しい高さ (-0.207) からずれている
  const r = petalFold(s, { line: h, side: S(h, 0.5, -1), pick: { x: 0.5, y: -1, select: 'top' } });
  assert.ok(r.error);
});
