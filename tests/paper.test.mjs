import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPaper, fold, flip, rotate, makeLine, bisectorLine, sideOf, totalArea,
  poseFaces, creasePattern, isFrontUp, bounds,
} from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';

const L = (ax, ay, bx, by) => makeLine({ x: ax, y: ay }, { x: bx, y: by });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('半分に谷折りすると面が2つ、面積は保存、片方が裏返る', () => {
  const s0 = createPaper();
  const line = L(0, -1, 0, 1);
  const { state, error } = fold(s0, { line, side: Math.sign(sideOf(line, { x: -0.5, y: 0 })), type: 'valley' });
  assert.equal(error, undefined);
  assert.equal(state.faces.length, 2);
  assert.ok(close(totalArea(state), 4));
  const b = bounds(state);
  assert.ok(close(b.minX, 0) && close(b.maxX, 1));
  const ups = state.faces.map(isFrontUp).sort();
  assert.deepEqual(ups, [false, true]);
  // 谷折りなので動いた面（裏向き）が上
  const moved = state.faces.find((f) => !isFrontUp(f));
  const still = state.faces.find((f) => isFrontUp(f));
  assert.ok(moved.layer > still.layer);
});

test('山折りでは動いた面が下になる', () => {
  const line = L(0, -1, 0, 1);
  const { state } = fold(createPaper(), { line, side: Math.sign(sideOf(line, { x: -0.5, y: 0 })), type: 'mountain' });
  const moved = state.faces.find((f) => !isFrontUp(f));
  const still = state.faces.find((f) => isFrontUp(f));
  assert.ok(moved.layer < still.layer);
});

test('紙のない側を選ぶとエラー', () => {
  const line = L(1.5, -1, 1.5, 1);
  const r = fold(createPaper(), { line, side: Math.sign(sideOf(line, { x: 2, y: 0 })), type: 'valley' });
  assert.ok(r.error);
});

test('角度0の姿勢は元の紙、180は折った状態', () => {
  const line = L(0, -1, 0, 1);
  const { state } = fold(createPaper(), { line, side: Math.sign(sideOf(line, { x: -0.5, y: 0 })), type: 'valley' });
  const open = poseFaces(state, [0]);
  let minX = Infinity;
  for (const { pts } of open) for (const p of pts) { minX = Math.min(minX, p[0]); assert.ok(Math.abs(p[2]) < 0.05); }
  assert.ok(close(minX, -1, 1e-9));
  // 90° では動いた面が上に立ち上がる（谷折り）
  const half = poseFaces(state, [90]);
  const maxZ = Math.max(...half.flatMap(({ pts }) => pts.map((p) => p[2])));
  assert.ok(maxZ > 0.9);
});

test('点を点に重ねる折り線', () => {
  const line = bisectorLine({ x: -1, y: -1 }, { x: 1, y: 1 });
  assert.ok(close(sideOf(line, { x: 1, y: -1 }), 0) && close(sideOf(line, { x: -1, y: 1 }), 0));
});

test('裏返し・回転で面積と面数が変わらない', () => {
  let s = createPaper();
  const line = L(-1, -1, 1, 1);
  s = fold(s, { line, side: 1, type: 'valley' }).state;
  const n = s.faces.length;
  s = flip(s).state;
  s = rotate(s, 90).state;
  assert.equal(s.faces.length, n);
  assert.ok(close(totalArea(s), 4));
  assert.equal(s.steps.length, 3);
});

test('選んだ部分だけ折る（一番上の層だけ）', () => {
  let s = createPaper();
  const l1 = L(0, -1, 0, 1);
  s = fold(s, { line: l1, side: Math.sign(sideOf(l1, { x: -0.5, y: 0 })), type: 'valley' }).state;
  // 右半分に 2 層。x=0.5 で一番上の層だけ折る
  const l2 = L(0.5, -1, 0.5, 1);
  const r = fold(s, { line: l2, side: Math.sign(sideOf(l2, { x: 0.8, y: 0 })), type: 'valley', mode: 'component', pick: { x: 0.8, y: 0, select: 'top' } });
  assert.equal(r.error, undefined);
  const moved = r.state.faces.filter((f) => f.moves.includes(1));
  assert.equal(moved.length, 1);
  assert.equal(r.state.faces.length, 3); // 下の層は分割されたまま残さない
  assert.ok(close(totalArea(r.state), 4));
});

test('展開図：半分の谷折りは谷線1本', () => {
  const line = L(0, -1, 0, 1);
  const { state } = fold(createPaper(), { line, side: Math.sign(sideOf(line, { x: -0.5, y: 0 })), type: 'valley' });
  const cp = creasePattern(state);
  assert.equal(cp.length, 1);
  assert.equal(cp[0].type, 'valley');
  const line2 = L(0, -1, 0, 1);
  const m = fold(createPaper(), { line: line2, side: Math.sign(sideOf(line2, { x: -0.5, y: 0 })), type: 'mountain' }).state;
  assert.equal(creasePattern(m)[0].type, 'mountain');
});

for (const preset of PRESETS.filter((p) => p.kind !== 'sim')) {
  test(`見本「${preset.name}」がすべて折れる`, () => {
    let s = createPaper();
    for (const op of preset.steps) {
      const r = applyOp(s, op);
      assert.equal(r.error, undefined, `${op.caption}: ${r.error}`);
      s = r.state;
    }
    assert.ok(close(totalArea(s), 4, 1e-6));
    assert.equal(s.steps.length, preset.steps.length);
  });
}
