// 見本の折り方（1辺 2 の正方形、中心が原点）
// 各手順:
//   fold: 折り線の 2 点 a, b、動かす側にある点 at、type（valley/mountain）
//         mode: 'component' のときは at の位置の一番上（select:'bottom' なら一番下）の部分だけ折る
//   angle: 完成後に設定する開き具合（度）
//   rotate / flip: 紙全体を回す・裏返す（rotate は deg 度）
// view: 完成後のカメラの位置（注視点からの相対位置）
// kind: 'sim' の見本は、展開図から物理シミュレーションで一度に折る（鶴）

import { fold, flip, rotate, makeLine, sideOf } from './paper.js';

const T = Math.tan((22.5 * Math.PI) / 180); // 0.4142...
const X = 2 * T; // 0.8284...
const R = Math.SQRT2; // 正方形を 45° 回したときの、中心から角までの距離

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
    kind: 'sim',
    view: [0.4, -0.9, 3.3],
    credit: '展開図: Origami Simulator (Amanda Ghassaei, MIT License)',
  },
];

// 見本の 1 手順を状態に適用する
export function applyOp(state, op) {
  if (op.op === 'flip') return flip(state);
  if (op.op === 'rotate') return rotate(state, op.deg ?? 90);
  const line = makeLine({ x: op.a[0], y: op.a[1] }, { x: op.b[0], y: op.b[1] });
  const at = { x: op.at[0], y: op.at[1] };
  return fold(state, {
    line,
    side: Math.sign(sideOf(line, at)),
    type: op.type,
    mode: op.mode ?? 'all',
    pick: { ...at, select: op.select ?? 'top' },
  });
}
