import * as THREE from 'three';
import { MAX_LABELS, fragmentShader, vertexShader } from './shaders';
import { BACKGROUND_COLOR, hexToRgb, labelColors } from './palette';

/** 描画パラメータ。距離はワールド単位（座標は [-1, 1] の立方体）。 */
export interface PointCloudParams {
  /** ビルボード1辺の大きさ */
  pointSize: number;
  /** 画面上の最小サイズ（CSS ではなく描画バッファのピクセル） */
  minPixelSize: number;
  /** 画面上の大きさがこの範囲で丸い点から数字へ切り替わる [点, 数字] */
  digitPixelRange: [number, number];
  /** 近接フェード [完全に消える距離, フェードが始まる距離]。pointSize に対する倍率 */
  nearFadeFactors: [number, number];
  /** 霧 [始まる距離, 1-1/e になるまでの距離, 上限] */
  fog: [number, number, number];
  /** 数字の縁取りの幅（インクの濃さの単位、0 で縁取りなし） */
  outline: number;
  /** 丸い点の半径 [セル幅に対する比, ピクセルでの上限] */
  dotRadius: [number, number];
}

export const DEFAULT_PARAMS: PointCloudParams = {
  pointSize: 0.004,
  minPixelSize: 3,
  digitPixelRange: [8, 14],
  nearFadeFactors: [1.5, 5],
  fog: [0.15, 0.9, 0.75],
  outline: 0.22,
  dotRadius: [0.4, 2.2],
};

export interface PointCloudData {
  positions: Float32Array;
  labels: Uint8Array;
  /** 各点のセル左上 UV（長さ 2 * count） */
  cellOrigins: Float32Array;
  cellSize: [number, number];
  labelCount: number;
  atlas: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  /** アトラスが白地に黒インクなら true */
  inkIsDark: boolean;
}

export class PointCloud {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /**
   * GPU ピッキング用のマテリアル。描画用と同じシェーダを PICKING で分岐させ、点の番号を出力する。
   * ユニフォームは描画用と同じオブジェクトを共有する（uViewportHeight だけはピッキング側が描く領域に合わせて持つ）。
   */
  readonly pickingMaterial: THREE.ShaderMaterial;
  readonly params: PointCloudParams;
  private readonly texture: THREE.Texture;

  constructor(data: PointCloudData, params: Partial<PointCloudParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    const count = data.labels.length;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(data.positions, 3));
    geometry.setAttribute('instanceLabel', new THREE.InstancedBufferAttribute(Float32Array.from(data.labels), 1));
    geometry.setAttribute('instanceCell', new THREE.InstancedBufferAttribute(data.cellOrigins, 2));
    geometry.instanceCount = count;
    // ビルボードはシェーダで広げるので、カリング用の境界は点群全体＋余白で十分
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

    const texture = new THREE.Texture(data.atlas);
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.texture = texture;

    const palette = labelColors(Math.min(data.labelCount, MAX_LABELS)).map((c) => new THREE.Vector3(...c));
    while (palette.length < MAX_LABELS) palette.push(new THREE.Vector3(1, 1, 1));

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uAtlas: { value: texture },
        uInkIsDark: { value: data.inkIsDark ? 1 : 0 },
        uCellSize: { value: new THREE.Vector2(...data.cellSize) },
        uPalette: { value: palette },
        uBackground: { value: new THREE.Vector3(...hexToRgb(BACKGROUND_COLOR)) },
        uPointSize: { value: 0 },
        uMinPixelSize: { value: 0 },
        uViewportHeight: { value: 1 },
        uDigitPx: { value: new THREE.Vector2() },
        uNearFade: { value: new THREE.Vector2() },
        uFog: { value: new THREE.Vector3() },
        uOutline: { value: 0 },
        uDotRadius: { value: new THREE.Vector2() },
      },
      transparent: false,
      depthTest: true,
      depthWrite: true,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });

    this.pickingMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines: { PICKING: '' },
      uniforms: { ...material.uniforms, uViewportHeight: { value: 1 } },
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
      alphaToCoverage: false,
      dithering: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.applyParams();
  }

  /** パラメータを部分的に更新する。 */
  set(params: Partial<PointCloudParams>): void {
    Object.assign(this.params, params);
    this.applyParams();
  }

  setViewportHeight(pixels: number): void {
    this.mesh.material.uniforms.uViewportHeight!.value = pixels;
  }

  /** ピッキング用マテリアルの描画先の高さ（画素）。画面上の大きさの計算に使う。 */
  setPickingViewportHeight(pixels: number): void {
    this.pickingMaterial.uniforms.uViewportHeight!.value = pixels;
  }

  private applyParams(): void {
    const u = this.mesh.material.uniforms;
    const p = this.params;
    u.uPointSize!.value = p.pointSize;
    u.uMinPixelSize!.value = p.minPixelSize;
    (u.uDigitPx!.value as THREE.Vector2).set(...p.digitPixelRange);
    (u.uNearFade!.value as THREE.Vector2).set(p.nearFadeFactors[0] * p.pointSize, p.nearFadeFactors[1] * p.pointSize);
    (u.uFog!.value as THREE.Vector3).set(...p.fog);
    u.uOutline!.value = p.outline;
    (u.uDotRadius!.value as THREE.Vector2).set(...p.dotRadius);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.pickingMaterial.dispose();
    this.texture.dispose();
  }
}
