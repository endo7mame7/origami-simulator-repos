// 見本の折り方（1辺 2 の正方形、中心が原点）
// 各手順:
//   fold: 折り線の 2 点 a, b、動かす側にある点 at、type（valley/mountain）
//         mode: 'component' のときは at の位置の一番上（select:'bottom' なら一番下）の部分だけ折る
//   angle: 完成後に設定する開き具合（度）
//   rotate / flip: 紙全体を回す・裏返す（rotate は deg 度）
// view: 完成後のカメラの位置（注視点からの相対位置）
// kind: 'sim' の見本は、展開図から物理シミュレーションで一度に折る（鶴）

import { fold, flip, rotate, squash, reverseFold, petalFold, makeLine, sideOf } from './paper.js';

const T = Math.tan((22.5 * Math.PI) / 180); // 0.4142...
const X = 2 * T; // 0.8284...
const R = Math.SQRT2; // 正方形を 45° 回したときの、中心から角までの距離

// 鶴：正方基本形（袋をつぶす ×2）→ 鳥の基本形（花弁折り ×2）→ 脚を細く → 中割りで首と尾 → 頭 → 羽
function CRANE_STEPS() {
  const HY = -0.5 + (1 - Math.SQRT1_2); // 花弁折りの線の高さ（正方基本形を回したあと）
  const TIP = [0.5, -0.5 - Math.SQRT1_2]; // 下の先
  // 首と尾：中心線上の点 Q から、斜め 30° の線で脚を中割り折り
  const Q = [0.5, HY - 0.16];
  const dir = (deg, len = 1) => [Q[0] + Math.cos((deg * Math.PI) / 180) * len, Q[1] + Math.sin((deg * Math.PI) / 180) * len];
  const NECK = [Q, dir(210)];
  const TAIL = [Q, dir(-30)];
  // 首の先（脚の先 TIP を NECK の線で折り返した点）の近くで、頭を中割り折り
  const refl = (p, [a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    return [2 * (a[0] + dx * t) - p[0], 2 * (a[1] + dy * t) - p[1]];
  };
  const NT = refl(TIP, NECK); // 首の先
  const nd = [NT[0] - Q[0], NT[1] - Q[1]];
  const nl = Math.hypot(...nd);
  const HC = [NT[0] - (nd[0] / nl) * 0.22, NT[1] - (nd[1] / nl) * 0.22]; // 先から 0.22 の所
  const hang = Math.atan2(nd[1], nd[0]) + (115 * Math.PI) / 180;
  const HEAD = [HC, [HC[0] + Math.cos(hang), HC[1] + Math.sin(hang)]];
  const HEADAT = [NT[0] - (nd[0] / nl) * 0.05, NT[1] - (nd[1] / nl) * 0.05];
  return [
    { op: 'flip', caption: '白い面を上にする' },
    { op: 'fold', a: [-1, 1], b: [1, -1], at: [0.7, 0.7], type: 'valley', caption: '対角線で三角に折る' },
    { op: 'fold', a: [-1, -1], b: [1, 1], at: [-0.8, 0.5], type: 'valley', caption: 'さらに半分の三角に折る' },
    { op: 'squash', a: [-1, -1], b: [0, 0], at: [0.2, -0.7], caption: '袋を開いてつぶす' },
    { op: 'flip', caption: '裏返す' },
    { op: 'squash', a: [1, -1], b: [0, 0], at: [-0.3, -0.8], caption: '反対側の袋も開いてつぶす（正方基本形）' },
    { op: 'rotate', deg: -45, caption: '開いている方を下に向ける' },
    { op: 'petal', a: [0, HY], b: [1, HY], at: [0.5, -1.0], caption: '花弁折り' },
    { op: 'flip', caption: '裏返す' },
    { op: 'petal', a: [0, HY], b: [1, HY], at: [0.5, -1.0], caption: '反対側も花弁折り（鳥の基本形）' },
    { op: 'reverse', a: NECK[0], b: NECK[1], at: [0.45, -1.0], caption: '左の脚を中割り折りで上げて首にする' },
    { op: 'reverse', a: TAIL[0], b: TAIL[1], at: [0.55, -1.0], caption: '右の脚も中割り折りで上げて尾にする' },
    { op: 'reverse', a: HEAD[0], b: HEAD[1], at: HEADAT, caption: '首の先を中割り折りして頭を作る' },
    { op: 'fold', a: [0, HY], b: [1, HY], at: [0.5, 0.4], type: 'valley', mode: 'component', caption: '手前の羽を下ろす', angle: 95 },
    { op: 'fold', a: [0, HY], b: [1, HY], at: [0.5, 0.4], type: 'mountain', mode: 'component', select: 'bottom', caption: '向こうの羽も下ろす', angle: 95 },
  ];
}

export const PRESETS = [
  {
    id: 'triangle',
    name: '三角（かんたん）',
    steps: [
      { op: 'fold', a: [-1, -1], b: [1, 1], at: [-0.6, 0.6], type: 'valley', caption: '対角線で半分に折る' },
      { op: 'fold', a: [0, 0], b: [1, -1], at: [0.8, 0.4], type: 'valley', caption: 'さらに半分に折る' },
    ],
  },
  {
    id: 'airplane',
    name: '紙飛行機',
    view: [3, 0.6, 1.6],
    steps: [
      { op: 'fold', a: [0, 1], b: [-1, 0], at: [-0.9, 0.9], type: 'valley', caption: '左上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [1, 0], at: [0.9, 0.9], type: 'valley', caption: '右上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [-X, -1], at: [-0.9, -0.5], type: 'valley', caption: '左のふちを中心線へ' },
      { op: 'fold', a: [0, 1], b: [X, -1], at: [0.9, -0.5], type: 'valley', caption: '右のふちを中心線へ' },
      { op: 'fold', a: [0, -1], b: [0, 1], at: [-0.3, -0.5], type: 'mountain', caption: '中心で山折り', angle: 150 },
      { op: 'fold', a: [0.22, -1], b: [0.22, 1], at: [0.5, -0.7], type: 'valley', mode: 'component', select: 'top', caption: '上の翼を折る', angle: 85 },
      { op: 'fold', a: [0.22, -1], b: [0.22, 1], at: [0.5, -0.7], type: 'mountain', mode: 'component', select: 'bottom', caption: '下の翼を折る', angle: 85 },
    ],
  },
  {
    id: 'fan',
    name: '屏風折り（扇）',
    view: [0.3, -2.6, 2.2],
    steps: [
      { op: 'fold', a: [0.5, -1], b: [0.5, 1], at: [0.8, 0], type: 'valley', caption: '右の 1/4 を谷折り', angle: 130 },
      { op: 'fold', a: [0, -1], b: [0, 1], at: [0.25, 0], type: 'mountain', caption: '中心で山折り', angle: 130 },
      { op: 'fold', a: [-0.5, -1], b: [-0.5, 1], at: [-0.8, 0], type: 'valley', caption: '左の 1/4 を谷折り', angle: 130 },
    ],
  },
  {
    id: 'kite',
    name: 'たこ形',
    view: [2.2, -2.2, 2],
    steps: [
      { op: 'fold', a: [-1, -1], b: [-1 + 2 * T, 1], at: [-0.95, 0.5], type: 'valley', caption: '左のふちを対角線に合わせる' },
      { op: 'fold', a: [-1, -1], b: [1, -1 + 2 * T], at: [0.5, -0.95], type: 'valley', caption: '下のふちを対角線に合わせる' },
      { op: 'fold', a: [-1, -1], b: [1, 1], at: [0.5, -0.5], type: 'mountain', caption: '対角線で山折り', angle: 120 },
    ],
  },
  {
    id: 'kabuto',
    name: '兜（かぶと）',
    view: [0, -1.4, 3],
    steps: [
      { op: 'flip', caption: '色の面を下にする' },
      { op: 'rotate', deg: 45, caption: 'ひし形に置く' },
      { op: 'fold', a: [-2, 0], b: [2, 0], at: [0, 1], type: 'valley', caption: '上の角を下の角に合わせて三角に' },
      { op: 'fold', a: [0, 0], b: [-R / 2, -R / 2], at: [-1.2, -0.1], type: 'valley', caption: '左の角を下の角へ' },
      { op: 'fold', a: [0, 0], b: [R / 2, -R / 2], at: [1.2, -0.1], type: 'valley', caption: '右の角を下の角へ' },
      { op: 'fold', a: [-1, -R / 2], b: [1, -R / 2], at: [-0.05, -1.25], type: 'valley', mode: 'component', caption: '左の角を上の角へ' },
      { op: 'fold', a: [-1, -R / 2], b: [1, -R / 2], at: [0.05, -1.25], type: 'valley', mode: 'component', caption: '右の角を上の角へ' },
      { op: 'fold', a: [0, -R / 2], b: [-R / 6, -R / 6], at: [-0.05, -0.1], type: 'valley', mode: 'component', caption: '左の角を外に折って「くわがた」に', angle: 165 },
      { op: 'fold', a: [0, -R / 2], b: [R / 6, -R / 6], at: [0.05, -0.1], type: 'valley', mode: 'component', caption: '右の角を外に折って「くわがた」に', angle: 165 },
      { op: 'fold', a: [-1, -0.93], b: [1, -0.93], at: [0, -1.3], type: 'valley', mode: 'component', caption: '下の角を 1 枚だけ上へ' },
      { op: 'fold', a: [-1, -R / 2], b: [1, -R / 2], at: [0, -0.8], type: 'valley', mode: 'component', caption: 'もう一度折り上げて「ひさし」に' },
      { op: 'fold', a: [-1, -R / 2], b: [1, -R / 2], at: [0, -1.2], type: 'mountain', mode: 'component', select: 'bottom', caption: '残りの角を後ろへ折る' },
    ],
  },
  {
    id: 'cicada',
    name: 'セミ',
    view: [0, -1.6, 3],
    steps: [
      { op: 'flip', caption: '色の面を下にする' },
      { op: 'rotate', deg: 45, caption: 'ひし形に置く' },
      { op: 'fold', a: [-2, 0], b: [2, 0], at: [0, -1], type: 'valley', caption: '下の角を上の角に合わせて三角に' },
      { op: 'fold', a: [0, 0], b: [-R / 2, R / 2], at: [-1.2, 0.1], type: 'valley', caption: '左の角を上の角へ' },
      { op: 'fold', a: [0, 0], b: [R / 2, R / 2], at: [1.2, 0.1], type: 'valley', caption: '右の角を上の角へ' },
      { op: 'fold', a: [0, 0.563], b: [-0.69, 0.713], at: [-0.05, 1.3], type: 'valley', mode: 'component', caption: '左の羽を斜めに折り下げる' },
      { op: 'fold', a: [0, 0.563], b: [0.69, 0.713], at: [0.05, 1.3], type: 'valley', mode: 'component', caption: '右の羽を斜めに折り下げる' },
      { op: 'fold', a: [-1, 1.018], b: [1, 1.018], at: [0, 1.35], type: 'valley', mode: 'component', caption: '上の角を 1 枚だけ折り下げる' },
      { op: 'fold', a: [-1, 1.131], b: [1, 1.131], at: [0, 1.35], type: 'valley', mode: 'component', caption: 'もう 1 枚を少し上で折り下げる' },
      { op: 'fold', a: [-0.42, -1], b: [-0.55, 1.5], at: [-1, 0.5], type: 'mountain', caption: '左のはしを後ろへ', angle: 120 },
      { op: 'fold', a: [0.42, -1], b: [0.55, 1.5], at: [1, 0.5], type: 'mountain', caption: '右のはしを後ろへ', angle: 120 },
    ],
  },
  {
    id: 'crane',
    name: '鶴',
    view: [1.6, -2.2, 1.6],
    steps: CRANE_STEPS(),
  },
];

// 見本の 1 手順を状態に適用する
export function applyOp(state, op) {
  if (op.op === 'flip') return flip(state);
  if (op.op === 'rotate') return rotate(state, op.deg ?? 90);
  const line = makeLine({ x: op.a[0], y: op.a[1] }, { x: op.b[0], y: op.b[1] });
  const at = { x: op.at[0], y: op.at[1] };
  const sideAt = Math.sign(sideOf(line, at));
  const pick = { ...at, select: op.select ?? 'top' };
  if (op.op === 'squash') return squash(state, { line, side: sideAt, pick });
  if (op.op === 'petal') return petalFold(state, { line, side: sideAt, pick });
  if (op.op === 'reverse') return reverseFold(state, { line, side: sideAt, pick });
  return fold(state, {
    line,
    side: Math.sign(sideOf(line, at)),
    type: op.type,
    mode: op.mode ?? 'all',
    pick: { ...at, select: op.select ?? 'top' },
  });
}
