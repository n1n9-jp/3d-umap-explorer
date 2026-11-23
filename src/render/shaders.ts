/**
 * 点群ビルボードのシェーダ。
 *
 * - 四角形はビュー空間でカメラに正対させ、ワールド空間で一定の大きさにする（近いほど大きい）。
 *   画面上で uMinPixelSize より小さくなる点は、その大きさまで拡大して消えないようにする。
 * - 形は「インクの濃さ」の場で表す。画面上で小さい点は数字が読めないので、丸い点の場へ滑らかに切り替える。
 * - 場を閾値で切ってアルファテスト＋深度書き込みで描く（並べ替え不要）。輪郭は fwidth で幅1ピクセルの
 *   遷移を作り、alphaToCoverage（MSAA）で滑らかにする。
 * - 数字の線の外側に背景色の縁取りを付け、重なった数字どうしを切り分ける。
 * - カメラのごく近くの点は、線を細らせながら消す。距離に応じて背景色へ溶かす。
 *
 * 画面上の大きさのユニフォーム（uMinPixelSize・uDigitPx・uDotRadius.y・強調表示の uRing）は描画バッファのピクセル単位。
 * PointCloud が CSS ピクセルの値に pixelRatio を掛けて渡すので、見かけの大きさは pixelRatio によらない。
 *
 * ラベル色は PALETTE_SIZE 色のパレットを繰り返して引く（ラベル番号を PALETTE_SIZE で割った余り）。
 * ラベルは uint8 なので、どのラベル（0..255）でも配列の範囲内を読む。
 *
 * DOTS_ONLY を define すると、画像（アトラス）を使わず、すべての点を丸い点の場で描く（画像のないデータセット用）。
 * 丸い点の半径は uDotRadius（ビルボードの 1 辺に対する比と、ピクセルでの上限）で決まり、ピッキングと強調表示の輪も同じ値を使う。
 *
 * 色の番号（instanceLabel）が負の点は、パレットではなく uNoiseColor（クラスタに属さない点の灰色）で描く。
 *
 * PICKING を define すると、同じ形の判定のまま「点の番号」を出力する（GPU ピッキング用）。
 * 出力は index + 1 を RGB の24ビットに入れたもの（R が下位8ビット）で、0 は点なし。
 * 判定は、MSAA の半分以上のサンプルが覆われるかどうかに相当する「アルファ 0.5 以上」とする。
 * 縁取りは背景色で描かれて背後を隠すので、番号 0 のまま深度だけを書く。
 */

import { LABEL_COLORS } from './palette';

/** シェーダのパレットの色数（ラベル色の繰り返しの周期）。 */
export const PALETTE_SIZE = LABEL_COLORS.length;

/**
 * 点群と単語の文字（src/text/）が共有する GLSL。「形を表す場を閾値で切る」描画の共通部分。
 * 使う側は、ここで参照するユニフォーム（uViewportHeight・uNearFade・uFog・uPalette・uNoiseColor）を宣言してから展開する。
 */
export const GLSL_VERTEX_COMMON = /* glsl */ `
// ビュー空間の奥行き depth での、ワールド 1 単位の画面上の大きさ（描画バッファの画素）
float pxPerUnitAt(float depth) {
  return 0.5 * uViewportHeight * projectionMatrix[1][1] / depth;
}
// 近接フェード（0: 完全に消える, 1: フェードなし）
float nearFadeAt(float dist) {
  return smoothstep(uNearFade.x, uNearFade.y, dist);
}
// 霧の濃さ（背景色へ溶かす割合）
float fogAt(float dist) {
  return uFog.z * (1.0 - exp(-max(dist - uFog.x, 0.0) / uFog.y));
}
// 色の番号の色（負なら uNoiseColor、それ以外はパレットを繰り返して引く）
vec3 paletteColor(float colorIndex) {
  if (colorIndex < -0.5) return uNoiseColor;
  int label = clamp(int(colorIndex + 0.5), 0, 65535);
  return uPalette[label % ${PALETTE_SIZE}];
}
`;

export const GLSL_FRAGMENT_COMMON = /* glsl */ `
// 閾値 t で場 f を切り、幅約1ピクセルの滑らかな遷移にする
float coverage(float f, float t) {
  float w = max(fwidth(f), 1e-4);
  return clamp((f - t) / w + 0.5, 0.0, 1.0);
}
// フェードの量（0..1）から、線を細らせる閾値と、消すためのアルファの係数
float fadeThreshold(float fade, float edge) {
  return mix(0.98, edge, fade);
}
float fadeAlpha(float fade) {
  return smoothstep(0.0, 0.35, fade);
}
// ピッキングの番号（index + 1。R が下位 8 ビット）
vec4 encodePickId(int id) {
  return vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), 255.0) / 255.0;
}
`;

export const vertexShader = /* glsl */ `
precision highp float;

in vec3 instancePosition;
in float instanceLabel;   // 色の番号（負なら uNoiseColor）
#ifndef DOTS_ONLY
in vec2 instanceCell;
#else
in float instanceDotScale; // 丸い点の半径の倍率（単語の文字を出している点は 0 へ）
#endif

uniform float uPointSize;
uniform float uMinPixelSize;
uniform float uViewportHeight;
uniform vec2 uCellSize;
uniform vec2 uDigitPx;     // x: これ以下は丸い点, y: これ以上は数字
uniform vec2 uNearFade;    // x: 完全に消える距離, y: フェードが始まる距離
uniform vec3 uFog;         // x: 霧の始まる距離, y: 霧が 1-1/e になるまでの距離, z: 霧の上限
uniform vec3 uPalette[${PALETTE_SIZE}];
uniform vec3 uNoiseColor;

out vec2 vUv;
out vec2 vLocal;
out vec3 vColor;
out float vDigit;
out float vFade;
out float vFog;
out float vPx;
#ifdef DOTS_ONLY
out float vDotScale;
#endif
#ifdef PICKING
flat out int vPickId;
#endif
${GLSL_VERTEX_COMMON}
void main() {
  vec4 mv = modelViewMatrix * vec4(instancePosition, 1.0);
  float dist = length(mv.xyz);
  float depth = max(-mv.z, 1e-6);

  float fade = nearFadeAt(dist);
#ifdef DOTS_ONLY
  // 単語の文字を出している点は、丸い点を縮めて消す（文字と重ならないように）
  if (fade <= 0.0 || instanceDotScale <= 0.001) {
#else
  if (fade <= 0.0) {
#endif
    // 視界から外す（クリップ空間の外へ）
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float pxPerUnit = pxPerUnitAt(depth);
  float px = uPointSize * pxPerUnit;
  float shownPx = max(px, uMinPixelSize);
  float size = shownPx / pxPerUnit;

  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;

  vLocal = position.xy;                         // -0.5..0.5
#ifdef DOTS_ONLY
  vUv = vec2(0.0);
  vDigit = 0.0;
#else
  vec2 cornerUv = vec2(position.x + 0.5, 0.5 - position.y); // v は下向き（画像の上端が 0）
  vUv = instanceCell + cornerUv * uCellSize;
  vDigit = smoothstep(uDigitPx.x, uDigitPx.y, shownPx);
#endif
  vColor = paletteColor(instanceLabel);
  vPx = shownPx;
#ifdef DOTS_ONLY
  vDotScale = instanceDotScale;
#endif
  vFade = fade;
  vFog = fogAt(dist);
#ifdef PICKING
  vPickId = gl_InstanceID + 1;
#endif
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

#ifndef DOTS_ONLY
uniform sampler2D uAtlas;
#endif
uniform float uInkIsDark;   // 1: 白地に黒インク（インク = 1 − 輝度）
uniform float uOutline;     // 縁取りの幅（場の単位）
uniform vec2 uDotRadius;    // 丸い点の半径 x: セル幅に対する比, y: ピクセルでの上限
uniform vec3 uBackground;

in vec2 vUv;
in vec2 vLocal;
in vec3 vColor;
in float vDigit;
in float vFade;
in float vFog;
in float vPx;
#ifdef DOTS_ONLY
in float vDotScale;
#endif
#ifdef PICKING
flat in int vPickId;
#endif

out vec4 fragColor;
${GLSL_FRAGMENT_COMMON}

void main() {
#ifdef DOTS_ONLY
  float ink = 0.0;
#else
  float lum = texture(uAtlas, vUv).r;
  float ink = mix(lum, 1.0 - lum, uInkIsDark);
#endif

  // 丸い点の場（ピクセル単位）：半径の位置で 0.5。中距離の点が大きな円盤にならないよう半径に上限を設ける
  float radiusPx = min(uDotRadius.x * vPx, uDotRadius.y);
#ifdef DOTS_ONLY
  radiusPx *= vDotScale;
#endif
  float disc = 0.5 + 0.1 * (radiusPx - length(vLocal) * vPx);
  float field = mix(disc, ink, vDigit);

  // 近接フェード：閾値を上げて線を細らせる
  float t = fadeThreshold(vFade, 0.5);
  float outline = uOutline * vDigit * vFade;

  float body = coverage(field, t);
  float alpha = coverage(field, t - outline);
  float fadeA = fadeAlpha(vFade);

#ifdef PICKING
  if (alpha * fadeA < 0.5) discard;
  if (body * fadeA < 0.5) {
    fragColor = vec4(0.0);  // 縁取り：背後を隠すが、点としては選ばない
  } else {
    fragColor = encodePickId(vPickId);
  }
#else
  alpha *= fadeA;
  if (alpha < 0.02) discard;

  vec3 color = mix(uBackground, vColor, body);
  color = mix(color, uBackground, vFog);
  fragColor = vec4(color, alpha);
#endif
}
`;

/**
 * 強調表示（ホバー・選択）の輪のシェーダ。点群とは別のメッシュとして、点群の後に深度テストなしで重ねて描く。
 * ほかの点に隠れていても輪は見えるので、点の位置が分かる。ピッキングは点群のメッシュだけを描くので、
 * 輪は選ばれる形に影響しない。
 *
 * 輪の半径は、点群のシェーダと同じ式で求めた点の画面上の大きさ（最小サイズで下支え）に合わせ、
 * 数字を囲む大きさにする（下限 uRing.x ピクセル）。輪は背景色の縁取りの内側に色を付けて、
 * 明るい点の上でも暗い背景の上でも読み取れるようにする。
 */
export const highlightVertexShader = /* glsl */ `
precision highp float;

uniform vec3 uCenter;
uniform float uPointSize;
uniform float uMinPixelSize;
uniform float uViewportHeight;
uniform vec3 uRing;        // x: 半径の下限, y: 線の太さ, z: 縁取りの太さ（いずれも描画バッファのピクセル）
uniform vec2 uDotRadius;   // 点群と共有（DOTS_ONLY のときだけ使う）
uniform vec4 uBox;         // 単語を囲む形 xy: 半分の幅と高さ, zw: 中心のずれ（ビュー空間のワールド単位）。x が 0 なら輪

out vec2 vPx;              // 中心からのずれ（ピクセル）
out float vRadius;
out vec2 vHalf;            // 単語を囲む矩形の半分の大きさ（ピクセル）。x が 0 なら輪

void main() {
  vec4 mv = modelViewMatrix * vec4(uCenter, 1.0);
  float depth = -mv.z;
  if (depth <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float pxPerUnit = 0.5 * uViewportHeight * projectionMatrix[1][1] / depth;
  if (uBox.x > 0.0) {
    // 単語の文字を囲む角の丸い矩形（文字の縁取りの外側に、線の太さの分だけ離す）
    vec2 halfSz = uBox.xy * pxPerUnit + vec2(0.5 * uRing.y + 3.0);
    vec2 ext = halfSz + vec2(0.5 * uRing.y + uRing.z + 2.0);
    vPx = position.xy * 2.0 * ext;
    vHalf = halfSz;
    vRadius = 0.0;
    mv.xy += uBox.zw + vPx / pxPerUnit;
    gl_Position = projectionMatrix * mv;
    return;
  }
  float shownPx = max(uPointSize * pxPerUnit, uMinPixelSize);
#ifdef DOTS_ONLY
  // 丸い点（点群と同じ式の半径）より少し外側
  float radius = max(min(uDotRadius.x * shownPx, uDotRadius.y) + 0.5 * uRing.y + 2.0, uRing.x);
#else
  // 数字のセルの外接円（半辺 × √2）より少し外側
  float radius = max(0.72 * shownPx + 2.0, uRing.x);
#endif
  float halfPx = radius + 0.5 * uRing.y + uRing.z + 2.0;

  vPx = position.xy * 2.0 * halfPx;
  vRadius = radius;
  vHalf = vec2(0.0);
  mv.xy += vPx / pxPerUnit;
  gl_Position = projectionMatrix * mv;
}
`;

export const highlightFragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uBackground;
uniform vec3 uRing;

in vec2 vPx;
in float vRadius;
in vec2 vHalf;

out vec4 fragColor;

void main() {
  float d;
  if (vHalf.x > 0.0) {
    // 角の丸い矩形の輪郭からの距離（ピクセル）
    float r = min(6.0, min(vHalf.x, vHalf.y));
    vec2 q = abs(vPx) - vHalf + vec2(r);
    d = abs(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r);
  } else {
    d = abs(length(vPx) - vRadius);  // 輪の中心線からの距離（ピクセル）
  }
  float halfLine = 0.5 * uRing.y;
  float body = clamp(halfLine + 0.5 - d, 0.0, 1.0);
  float alpha = clamp(halfLine + uRing.z + 0.5 - d, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  fragColor = vec4(mix(uBackground, uColor, body), alpha);
}
`;
