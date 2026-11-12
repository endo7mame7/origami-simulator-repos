import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, FoldSim, dihedral } from '../js/sim.js';
import { BIRD_BASE_CP } from '../js/data/bird-base-cp.js';
import { CRANE_CP } from '../js/data/crane-cp.js';

test('二面角：谷折りで正、山折りで負', () => {
  const h = { a: 0, b: 1, c: 2, d: 3 };
  const P = (dz) => Float64Array.from([0, -1, 0, 0, 1, 0, -1, 0, 0, 1, 0, dz]);
  assert.ok(dihedral(P(0.5), h) > 0);
  assert.ok(dihedral(P(-0.5), h) < 0);
});

test('二面角の勾配が数値微分と一致する', () => {
  const h = { a: 0, b: 1, c: 2, d: 3 };
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
  for (let trial = 0; trial < 10; trial++) {
    const p = Float64Array.from([0, -1, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0].map((v) => v + rnd()));
    const g = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    dihedral(p, h, g);
    for (let v = 0; v < 4; v++) {
      for (let q = 0; q < 3; q++) {
        const e = 1e-6;
        const pp = Float64Array.from(p); pp[3 * v + q] += e;
        const pm = Float64Array.from(p); pm[3 * v + q] -= e;
        const fd = (dihedral(pp, h) - dihedral(pm, h)) / (2 * e);
        assert.ok(Math.abs(fd - g[v][q]) < 1e-5);
      }
    }
  }
});

function fold(cp, frames, iters) {
  const m = buildModel(cp, 2);
  const sim = new FoldSim(m);
  for (let f = 0; f <= frames; f++) {
    sim.percent = Math.min(1, f / frames) * 0.99;
    sim.step(iters);
  }
  let maxStrain = 0;
  for (const b of m.bars) {
    const p = sim.pos;
    const l = Math.hypot(p[3 * b.j] - p[3 * b.i], p[3 * b.j + 1] - p[3 * b.i + 1], p[3 * b.j + 2] - p[3 * b.i + 2]);
    maxStrain = Math.max(maxStrain, Math.abs(l - b.l0) / b.l0);
  }
  return { sim, maxStrain };
}

test('鳥の基本形が平らに折りたためる', () => {
  const { sim, maxStrain } = fold(BIRD_BASE_CP, 150, 100);
  assert.ok(sim.error() < 0.05, `角度の誤差 ${sim.error()}`);
  assert.ok(maxStrain < 0.01);
});

test('鶴のシミュレーションが発散しない', () => {
  const { sim, maxStrain } = fold(CRANE_CP, 120, 100);
  assert.ok(!sim.pos.some(Number.isNaN));
  assert.ok(maxStrain < 1, `伸び ${maxStrain}`);
});
