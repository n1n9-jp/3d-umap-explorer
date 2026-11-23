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
 */

export const MAX_LABELS = 32;

export const vertexShader = /* glsl */ `
precision highp float;

in vec3 instancePosition;
in float instanceLabel;
in vec2 instanceCell;

uniform float uPointSize;
uniform float uMinPixelSize;
uniform float uViewportHeight;
uniform vec2 uCellSize;
uniform vec2 uDigitPx;     // x: これ以下は丸い点, y: これ以上は数字
uniform vec2 uNearFade;    // x: 完全に消える距離, y: フェードが始まる距離
uniform vec3 uFog;         // x: 霧の始まる距離, y: 霧が 1-1/e になるまでの距離, z: 霧の上限
uniform vec3 uPalette[${MAX_LABELS}];

out vec2 vUv;
out vec2 vLocal;
out vec3 vColor;
out float vDigit;
out float vFade;
out float vFog;
out float vPx;

void main() {
  vec4 mv = modelViewMatrix * vec4(instancePosition, 1.0);
  float dist = length(mv.xyz);
  float depth = max(-mv.z, 1e-6);

  float fade = smoothstep(uNearFade.x, uNearFade.y, dist);
  if (fade <= 0.0) {
    // 視界から外す（クリップ空間の外へ）
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float pxPerUnit = 0.5 * uViewportHeight * projectionMatrix[1][1] / depth;
  float px = uPointSize * pxPerUnit;
  float shownPx = max(px, uMinPixelSize);
  float size = shownPx / pxPerUnit;

  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;

  vLocal = position.xy;                         // -0.5..0.5
  vec2 cornerUv = vec2(position.x + 0.5, 0.5 - position.y); // v は下向き（画像の上端が 0）
  vUv = instanceCell + cornerUv * uCellSize;
  vColor = uPalette[int(instanceLabel + 0.5)];
  vDigit = smoothstep(uDigitPx.x, uDigitPx.y, shownPx);
  vPx = shownPx;
  vFade = fade;
  vFog = uFog.z * (1.0 - exp(-max(dist - uFog.x, 0.0) / uFog.y));
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
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

out vec4 fragColor;

// 閾値 t で場 f を切り、幅約1ピクセルの滑らかな遷移にする
float coverage(float f, float t) {
  float w = max(fwidth(f), 1e-4);
  return clamp((f - t) / w + 0.5, 0.0, 1.0);
}

void main() {
  float lum = texture(uAtlas, vUv).r;
  float ink = mix(lum, 1.0 - lum, uInkIsDark);

  // 丸い点の場（ピクセル単位）：半径の位置で 0.5。中距離の点が大きな円盤にならないよう半径に上限を設ける
  float radiusPx = min(uDotRadius.x * vPx, uDotRadius.y);
  float disc = 0.5 + 0.1 * (radiusPx - length(vLocal) * vPx);
  float field = mix(disc, ink, vDigit);

  // 近接フェード：閾値を上げて線を細らせる
  float t = mix(0.98, 0.5, vFade);
  float outline = uOutline * vDigit * vFade;

  float body = coverage(field, t);
  float alpha = coverage(field, t - outline);
  alpha *= smoothstep(0.0, 0.35, vFade);
  if (alpha < 0.02) discard;

  vec3 color = mix(uBackground, vColor, body);
  color = mix(color, uBackground, vFog);
  fragColor = vec4(color, alpha);
}
`;
