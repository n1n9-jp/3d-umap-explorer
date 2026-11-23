/**
 * 単語の文字のシェーダ。文字 1 つを 1 インスタンスとして描く。
 *
 * - 単語は点の位置を基準に、ビュー空間でカメラに正対させる。文字の大きさはワールド空間で一定
 *   （1 em = uTextScale × uPointSize。点群の uPointSize を共有するので、`[` `]` キーに追従する）。
 * - 形は SDF の値を閾値で切る。点群（src/render/shaders.ts）と同じ共通の GLSL（輪郭の滑らかさ・近接フェード・霧・
 *   ピッキングの番号）を使う。
 * - 縁取り（背景色）と文字の本体は、別のパスで描く（OUTLINE_PASS）。縁取りは polygonOffset で奥へずらすので、
 *   隣の文字の縁取りが文字の本体を削らない。
 * - 単語の表示の切り替え（不透明度）は、近接フェードと同じく、線を細らせながら消す。
 * - PICKING では、本体の画素に点の番号を出し、縁取りは番号 0 のまま深度だけを書く（点群と同じ規則）。
 */
import { GLSL_FRAGMENT_COMMON, GLSL_VERTEX_COMMON, PALETTE_SIZE } from '../render/shaders';

export const wordVertexShader = /* glsl */ `
precision highp float;

in vec3 iPoint;    // 点の位置
in vec4 iQuad;     // 文字の四角形（基準点から左下の角までのずれと大きさ。em）
in vec4 iUv;       // アトラス上の位置 (u0, v0, u1, v1)。v0 が上端
in vec3 iStyle;    // x: 色の番号, y: 不透明度, z: 点の番号

uniform float uPointSize;
uniform float uViewportHeight;
uniform float uTextScale;
uniform vec2 uNearFade;
uniform vec3 uFog;
uniform vec3 uPalette[${PALETTE_SIZE}];
uniform vec3 uNoiseColor;

out vec2 vUv;
out vec3 vColor;
out float vFade;
out float vFog;
#ifdef PICKING
flat out int vPickId;
#endif
${GLSL_VERTEX_COMMON}
void main() {
  vec4 mv = modelViewMatrix * vec4(iPoint, 1.0);
  float dist = length(mv.xyz);
  float fade = nearFadeAt(dist) * iStyle.y;
  if (fade <= 0.0 || mv.z >= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float em = uTextScale * uPointSize;
  vec2 corner = position.xy + 0.5;   // 0..1（PlaneGeometry の -0.5..0.5）
  mv.xy += (iQuad.xy + corner * iQuad.zw) * em;
  gl_Position = projectionMatrix * mv;

  vUv = vec2(mix(iUv.x, iUv.z, corner.x), mix(iUv.w, iUv.y, corner.y));
  vColor = paletteColor(iStyle.x);
  vFade = fade;
  vFog = fogAt(dist);
#ifdef PICKING
  vPickId = int(iStyle.z + 0.5) + 1;
#endif
}
`;

export const wordFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform float uEdge;       // SDF の輪郭の値（1 − cutoff）
uniform float uOutline;    // 縁取りの幅（SDF の値の単位）
uniform vec3 uBackground;

in vec2 vUv;
in vec3 vColor;
in float vFade;
in float vFog;
#ifdef PICKING
flat in int vPickId;
#endif

out vec4 fragColor;
${GLSL_FRAGMENT_COMMON}
void main() {
  float field = texture(uAtlas, vUv).r;
  float t = fadeThreshold(vFade, uEdge);
  float fadeA = fadeAlpha(vFade);
#ifdef OUTLINE_PASS
  float alpha = coverage(field, t - uOutline * vFade);
#ifdef PICKING
  if (alpha * fadeA < 0.5) discard;
  fragColor = vec4(0.0);   // 縁取り：背後を隠すが、点としては選ばない
#else
  alpha *= fadeA;
  if (alpha < 0.02) discard;
  fragColor = vec4(uBackground, alpha);
#endif
#else
  float body = coverage(field, t);
#ifdef PICKING
  if (body * fadeA < 0.5) discard;
  fragColor = encodePickId(vPickId);
#else
  body *= fadeA;
  if (body < 0.02) discard;
  fragColor = vec4(mix(vColor, uBackground, vFog), body);
#endif
#endif
}
`;
