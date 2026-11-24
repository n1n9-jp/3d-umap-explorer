/**
 * 選択中の点の「元の空間で近い点」を、3 次元の地図の上で示す表示（src/neighbors/）。
 *
 * - 近傍の輪: 近傍の点を、水色の輪で囲む（選択の黄色の輪・ホバーの白い輪とは色で区別する）。地図の上でも近傍にある点は実線、
 *   地図では離れている点は破線の輪にする。深度テストなしで点群の後に描くので、ほかの点に隠れていても位置が分かる。
 * - 線: 選択中の点から、それぞれの近傍へ、画面上で一定の太さの細い線を引く。近い順位ほど濃く、遠い順位ほど薄い。
 *   選択の輪と近傍の輪の内側には線を描かない（点そのものと単語の文字を線で覆わない）。端点がカメラの後ろへ回ったときは、
 *   クリップ座標で手前のクリップ面に合わせて切り、画面の外へ向かう線として描く（線をたどると、画面の外の近傍の方向が分かる）。
 * - 一覧の項目にカーソルを重ねた近傍（`setFocus`）は、輪を大きく、線を太く濃くする。
 *
 * どちらも点群のメッシュとは別の表示で、GPU ピッキング（点群のメッシュと単語の文字の層だけを描く）には描かれないので、
 * 選ばれる形は変わらない。
 */
import * as THREE from 'three';
import type { PointCloud } from './pointCloud';
import { hexToRgb } from './palette';

/** 近傍の強調の色（選択の黄色 #ffc233・ホバーの白 #f2f5fa と区別する水色） */
export const NEIGHBOR_COLOR = '#4fd8ff';

/** 見た目の既定値（CSS ピクセル。描画バッファへは pixelRatio を掛ける） */
export const NEIGHBOR_STYLE = {
  /** 近傍の輪の半径の下限・線の太さ・縁取りの太さ */
  ringMinRadius: 6,
  ringLine: 1.5,
  ringOutline: 1.25,
  /** 線の太さ */
  lineWidth: 1.5,
  /** 線を描かない、選択中の点の周りの半径（選択の輪の外側） */
  lineGapStart: 13,
  /** 線の濃さ（1 番目に近い点・最後の点） */
  lineAlpha: [0.85, 0.4] as [number, number],
  /** 輪の濃さ（1 番目・最後） */
  ringAlpha: [1, 0.6] as [number, number],
};

const lineVertexShader = /* glsl */ `
precision highp float;
in vec3 aEnd;
in float aRank;
in float aId;
in vec4 aBox;             // 単語を囲む形（輪の頂点シェーダと同じ）。x が 0 なら輪
uniform vec3 uStart;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uFocus;
uniform vec2 uGap;        // x: 始点（選択の輪）, y: 終点（近傍の輪）の周りの線を描かない半径の下限（描画バッファのピクセル）
uniform vec2 uAlpha;      // 1 番目・最後の濃さ
uniform float uPointSize;
uniform float uMinPixelSize;
uniform float uViewportHeight;
uniform vec2 uDotRadius;
// 奥行き w の点の、点群の描画での見かけの半径（描画バッファのピクセル。輪の半径と同じ式）
float shownRadius(float w) {
  float pxPerUnit = 0.5 * uViewportHeight * projectionMatrix[1][1] / max(w, 1e-6);
  float shownPx = max(uPointSize * pxPerUnit, uMinPixelSize);
#ifdef DOTS_ONLY
  return min(uDotRadius.x * shownPx, uDotRadius.y);
#else
  return 0.72 * shownPx;
#endif
}
out float vAlong;
out float vLen;
out float vSide;
out float vHalf;
out float vAlpha;
out vec2 vGap;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(uStart, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);
  // 手前のクリップ面（z = -w）より奥の部分だけを残す
  float da = a.z + a.w, db = b.z + b.w;
  if (da <= 0.0 && db <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 gap = vec2(max(uGap.x, shownRadius(a.w) + 6.0), max(uGap.y, shownRadius(b.w) + 4.0));
  // 単語を出している近傍は、単語を囲む形の外側まで線を描かない
  if (aBox.x > 0.0) gap.y = max(gap.y, length(aBox.xy) + length(aBox.zw) + 2.0);
  if (da < 0.0) { a = mix(a, b, da / (da - db)); gap.x = 0.0; }
  else if (db < 0.0) { b = mix(b, a, db / (db - da)); gap.y = 0.0; }
  vec2 sa = (a.xy / a.w * 0.5 + 0.5) * uViewport;
  vec2 sb = (b.xy / b.w * 0.5 + 0.5) * uViewport;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float focus = abs(aId - uFocus) < 0.5 ? 1.0 : 0.0;
  float hw = 0.5 * uWidth * (1.0 + focus);
  float ext = hw + 1.0;
  vec2 s = mix(sa, sb, position.x) + n * position.y * ext;
  vAlong = position.x * len;
  vLen = len;
  vSide = position.y * ext;
  vHalf = hw;
  vGap = gap;
  vAlpha = focus > 0.5 ? 1.0 : mix(uAlpha.x, uAlpha.y, aRank);
  gl_Position = vec4(s / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
`;

const lineFragmentShader = /* glsl */ `
precision highp float;
uniform vec3 uColor;
in float vAlong;
in float vLen;
in float vSide;
in float vHalf;
in float vAlpha;
in vec2 vGap;
out vec4 fragColor;
void main() {
  if (vAlong < vGap.x || vAlong > vLen - vGap.y) discard;
  float cover = clamp(vHalf + 0.5 - abs(vSide), 0.0, 1.0);
  float a = cover * vAlpha;
  if (a <= 0.0) discard;
  fragColor = vec4(uColor, a);
}
`;

const ringVertexShader = /* glsl */ `
precision highp float;
in vec3 aCenter;
in float aRank;
in float aId;
in float aInMap;
in vec4 aBox;             // 単語を出している近傍の、単語を囲む形 xy: 半分の幅と高さ, zw: 中心のずれ（描画バッファのピクセル、上が正）。x が 0 なら輪
uniform float uPointSize;
uniform float uMinPixelSize;
uniform float uViewportHeight;
uniform vec2 uDotRadius;
uniform vec3 uRing;       // x: 半径の下限, y: 線の太さ, z: 縁取りの太さ（描画バッファのピクセル）
uniform float uFocus;
uniform vec2 uAlpha;
out vec2 vPx;
out float vRadius;
out float vAlpha;
out float vDashed;
out float vLine;
out vec2 vHalf;
void main() {
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float depth = -mv.z;
  if (depth <= 1e-6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float pxPerUnit = 0.5 * uViewportHeight * projectionMatrix[1][1] / depth;
  float shownPx = max(uPointSize * pxPerUnit, uMinPixelSize);
  float focus = abs(aId - uFocus) < 0.5 ? 1.0 : 0.0;
#ifdef DOTS_ONLY
  float radius = max(min(uDotRadius.x * shownPx, uDotRadius.y) + 0.5 * uRing.y + 1.5, uRing.x);
#else
  float radius = max(0.72 * shownPx + 1.5, uRing.x);
#endif
  radius *= 1.0 + 0.45 * focus;
  float line = uRing.y * (1.0 + 0.5 * focus);
  vLine = line;
  vAlpha = focus > 0.5 ? 1.0 : mix(uAlpha.x, uAlpha.y, aRank);
  vDashed = aInMap > 0.5 ? 0.0 : 1.0;
  if (aBox.x > 0.0) {
    // 単語の文字を囲む角の丸い矩形（文字の上に輪を重ねない）
    vec2 halfSz = aBox.xy + vec2(0.5 * line + 2.0 + 2.0 * focus);
    vec2 ext = halfSz + vec2(0.5 * line + uRing.z + 2.0);
    vPx = position.xy * 2.0 * ext;
    vHalf = halfSz;
    vRadius = 0.0;
    mv.xy += (aBox.zw + vPx) / pxPerUnit;
    gl_Position = projectionMatrix * mv;
    return;
  }
  float halfPx = radius + 0.5 * line + uRing.z + 2.0;
  vPx = position.xy * 2.0 * halfPx;
  vRadius = radius;
  vHalf = vec2(0.0);
  mv.xy += vPx / pxPerUnit;
  gl_Position = projectionMatrix * mv;
}
`;

const ringFragmentShader = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uBackground;
uniform vec3 uRing;
in vec2 vPx;
in float vRadius;
in float vAlpha;
in float vDashed;
in float vLine;
in vec2 vHalf;
out vec4 fragColor;
void main() {
  float d;
  if (vHalf.x > 0.0) {
    float r = min(5.0, min(vHalf.x, vHalf.y));
    vec2 q = abs(vPx) - vHalf + vec2(r);
    d = abs(length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r);
  } else {
    d = abs(length(vPx) - vRadius);
  }
  float halfLine = 0.5 * vLine;
  float body = clamp(halfLine + 0.5 - d, 0.0, 1.0);
  float alpha = clamp(halfLine + uRing.z + 0.5 - d, 0.0, 1.0);
  if (vDashed > 0.5) {
    // 地図では離れている近傍は破線（輪は 8 つ、単語を囲む矩形は 16 の切れ目）
    float t = fract(atan(vPx.y, vPx.x) / 6.2831853 * (vHalf.x > 0.0 ? 16.0 : 8.0));
    if (t > 0.6) discard;
  }
  alpha *= vAlpha;
  if (alpha <= 0.0) discard;
  fragColor = vec4(mix(uBackground, uColor, body), alpha);
}
`;

export class NeighborOverlay {
  /** 線と輪をまとめたグループ（DatasetView.root に加える） */
  readonly group = new THREE.Group();
  readonly capacity: number;
  private readonly lineMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly ringMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly ends: THREE.InstancedBufferAttribute;
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly inMapAttr: THREE.InstancedBufferAttribute;
  private readonly boxes: THREE.InstancedBufferAttribute;
  private readonly ranks: Float32Array;
  private count = 0;
  private pixelRatio = 1;
  private readonly quads: THREE.BufferGeometry[] = [];

  constructor(cloud: PointCloud, capacity: number) {
    this.capacity = Math.max(1, capacity);
    const n = this.capacity;
    const color = new THREE.Vector3(...hexToRgb(NEIGHBOR_COLOR));
    const ids = new Float32Array(n).map((_, i) => i);
    this.ranks = new Float32Array(n);
    this.ends = new THREE.InstancedBufferAttribute(new Float32Array(3 * n), 3);
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(3 * n), 3);
    this.inMapAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.boxes = new THREE.InstancedBufferAttribute(new Float32Array(4 * n), 4);
    for (const a of [this.ends, this.centers, this.inMapAttr, this.boxes]) a.setUsage(THREE.DynamicDrawUsage);
    const rankAttr = new THREE.InstancedBufferAttribute(this.ranks, 1);

    // 線: 長さの方向に x ∈ [0, 1]、太さの方向に y ∈ [-1, 1] の四角形
    const lineQuad = new THREE.PlaneGeometry(1, 2);
    lineQuad.translate(0.5, 0, 0);
    this.quads.push(lineQuad);
    const lg = new THREE.InstancedBufferGeometry();
    lg.index = lineQuad.index;
    lg.setAttribute('position', lineQuad.getAttribute('position'));
    lg.setAttribute('aEnd', this.ends);
    lg.setAttribute('aRank', rankAttr);
    lg.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1));
    lg.setAttribute('aBox', this.boxes);
    lg.instanceCount = 0;
    const cu = cloud.mesh.material.uniforms;
    const defines: Record<string, string> = cloud.dotsOnly ? { DOTS_ONLY: '' } : {};
    this.lineMesh = new THREE.Mesh(lg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: lineVertexShader,
      fragmentShader: lineFragmentShader,
      defines: { ...defines },
      uniforms: {
        uPointSize: cu.uPointSize!,
        uMinPixelSize: cu.uMinPixelSize!,
        uViewportHeight: cu.uViewportHeight!,
        uDotRadius: cu.uDotRadius!,
        uStart: { value: new THREE.Vector3() },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uWidth: { value: 1 },
        uFocus: { value: -1 },
        uGap: { value: new THREE.Vector2() },
        uAlpha: { value: new THREE.Vector2(...NEIGHBOR_STYLE.lineAlpha) },
        uColor: { value: color.clone() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 7;

    const ringQuad = new THREE.PlaneGeometry(1, 1);
    this.quads.push(ringQuad);
    const rg = new THREE.InstancedBufferGeometry();
    rg.index = ringQuad.index;
    rg.setAttribute('position', ringQuad.getAttribute('position'));
    rg.setAttribute('aCenter', this.centers);
    rg.setAttribute('aRank', rankAttr);
    rg.setAttribute('aId', new THREE.InstancedBufferAttribute(ids.slice(), 1));
    rg.setAttribute('aInMap', this.inMapAttr);
    rg.setAttribute('aBox', this.boxes);
    rg.instanceCount = 0;
    this.ringMesh = new THREE.Mesh(rg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ringVertexShader,
      fragmentShader: ringFragmentShader,
      defines: { ...defines },
      uniforms: {
        // 画面上の大きさは点群と同じ式で求めるので、ユニフォームを共有する
        uPointSize: cu.uPointSize!,
        uMinPixelSize: cu.uMinPixelSize!,
        uViewportHeight: cu.uViewportHeight!,
        uBackground: cu.uBackground!,
        uDotRadius: cu.uDotRadius!,
        uRing: { value: new THREE.Vector3() },
        uFocus: { value: -1 },
        uAlpha: { value: new THREE.Vector2(...NEIGHBOR_STYLE.ringAlpha) },
        uColor: { value: color.clone() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 8; // 選択・ホバーの輪（11・12）より下
    this.group.add(this.lineMesh, this.ringMesh);
    this.group.visible = false;
    this.applyStyle();
  }

  /**
   * 表示する近傍を設定する。`inMap[k]` は、k 番目の近傍が地図の上でも近傍にあるか。空の配列で何も描かない。
   * 位置は `setPositions` で渡す。
   */
  setNeighbors(inMap: readonly boolean[]): void {
    const n = Math.min(this.capacity, inMap.length);
    this.count = n;
    const flags = this.inMapAttr.array as Float32Array;
    for (let k = 0; k < this.capacity; k++) {
      flags[k] = k < n && inMap[k] ? 1 : 0;
      this.ranks[k] = n > 1 ? Math.min(1, k / (n - 1)) : 0;
    }
    this.inMapAttr.needsUpdate = true;
    (this.lineMesh.geometry.getAttribute('aRank') as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.lineMesh.geometry.instanceCount = n;
    this.ringMesh.geometry.instanceCount = n;
  }

  /** 選択中の点と近傍の位置（ワールド座標。`ends` は長さ 3 × 近傍の数）。値が変わったときだけ GPU へ送る。 */
  setPositions(start: ArrayLike<number>, ends: ArrayLike<number>): void {
    const s = this.lineMesh.material.uniforms.uStart!.value as THREE.Vector3;
    s.set(start[0]!, start[1]!, start[2]!);
    const e = this.ends.array as Float32Array, c = this.centers.array as Float32Array;
    let changed = false;
    const m = Math.min(ends.length, 3 * this.count);
    for (let k = 0; k < m; k++) {
      const v = Math.fround(ends[k]!);
      if (e[k] !== v) { e[k] = v; c[k] = v; changed = true; }
    }
    if (changed) { this.ends.needsUpdate = true; this.centers.needsUpdate = true; }
  }

  /**
   * 単語の文字を出している近傍を、輪の代わりに単語を囲む矩形にする。`box(k)` は k 番目の近傍の、点の中心から見た単語の矩形
   * （CSS ピクセル。中心のずれ dx・dy は右・下が正、半分の幅と高さ）。単語を出していなければ null。値が変わったときだけ GPU へ送る。
   */
  setWordBoxes(box: (rank: number) => { dx: number; dy: number; hw: number; hh: number } | null): void {
    const a = this.boxes.array as Float32Array, r = this.pixelRatio;
    let changed = false;
    for (let k = 0; k < this.capacity; k++) {
      const b = k < this.count ? box(k) : null;
      const v = b ? [Math.fround(b.hw * r), Math.fround(b.hh * r), Math.fround(b.dx * r), Math.fround(-b.dy * r)] : [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) if (a[4 * k + c] !== v[c]) { a[4 * k + c] = v[c]!; changed = true; }
    }
    if (changed) this.boxes.needsUpdate = true;
  }

  /** 一覧の項目にカーソルを重ねた近傍（順位の番号 0 から。-1 でなし）を目立たせる。 */
  setFocus(rank: number): void {
    this.lineMesh.material.uniforms.uFocus!.value = rank;
    this.ringMesh.material.uniforms.uFocus!.value = rank;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  get visible(): boolean {
    return this.group.visible && this.count > 0;
  }

  /** 描画バッファの大きさ（画素）と、描画バッファの画素 / CSS ピクセル。 */
  setViewport(width: number, height: number, pixelRatio: number): void {
    (this.lineMesh.material.uniforms.uViewport!.value as THREE.Vector2).set(Math.max(1, width), Math.max(1, height));
    if (pixelRatio > 0 && Number.isFinite(pixelRatio)) this.pixelRatio = pixelRatio;
    this.applyStyle();
  }

  private applyStyle(): void {
    const r = this.pixelRatio, s = NEIGHBOR_STYLE;
    const lu = this.lineMesh.material.uniforms;
    lu.uWidth!.value = s.lineWidth * r;
    // 終点の周りは、近傍の輪の外側まで線を描かない
    (lu.uGap!.value as THREE.Vector2).set(s.lineGapStart * r, (s.ringMinRadius + 2) * r);
    (this.ringMesh.material.uniforms.uRing!.value as THREE.Vector3).set(s.ringMinRadius * r, s.ringLine * r, s.ringOutline * r);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.lineMesh.geometry.dispose();
    this.lineMesh.material.dispose();
    this.ringMesh.geometry.dispose();
    this.ringMesh.material.dispose();
    for (const q of this.quads) q.dispose();
  }
}
