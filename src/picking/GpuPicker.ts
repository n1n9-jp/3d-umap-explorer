import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import { decodePickId, selectNearest } from './pickId';

export interface PickResult {
  /** 点の番号（データの添字） */
  index: number;
  /** カーソルの画素から選ばれた画素までの距離（CSS ピクセル）。真下なら 0 */
  pixelDistance: number;
}

export interface GpuPickerOptions {
  /** 吸着の半径（CSS ピクセル）。既定 7 */
  radiusPx?: number;
}

/** 番号の画像（全画面）。検証用。 */
export interface IdImage {
  width: number;
  height: number;
  /** 上の行から並べた点の番号。点がなければ -1 */
  ids: Int32Array;
}

/**
 * GPU ピッキング。描画と同じシェーダ（PICKING で分岐）で、カーソルの周りの小領域だけに点の番号を描いて読み出す。
 *
 * 小領域だけを描くには、カメラの複製に setViewOffset を設定する。投影行列が小領域の錐台に切り替わり、
 * 描画バッファの画素と小領域の画素が1対1に対応する。シェーダの画面上の大きさは
 * 0.5 * uViewportHeight * projectionMatrix[1][1] で求めているので、uViewportHeight を小領域の高さにすると
 * 全画面の描画と同じ値になる（projectionMatrix[1][1] が 全体の高さ / 小領域の高さ 倍になるため）。
 *
 * 呼び出しが重なっても、各呼び出しはその時点のカメラと位置に対する正しい結果を返す。
 * 描画と readPixels（PBO への転送）は pick() の同期部分で発行し、GPU の命令順で前後の描画と分離されるため。
 * 古い要求を捨てたい場合（ホバーなど）は、呼び出し側で最新の要求の結果だけを使う。
 */
export class GpuPicker {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cloud: PointCloud;
  private readonly radiusPx: number;
  private readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh;
  private readonly pickCamera = new THREE.PerspectiveCamera();
  private target: THREE.WebGLRenderTarget | null = null;
  private fullTarget: THREE.WebGLRenderTarget | null = null;
  private readonly savedClearColor = new THREE.Color();
  private readonly bufferSize = new THREE.Vector2();

  constructor(renderer: THREE.WebGLRenderer, cloud: PointCloud, options: GpuPickerOptions = {}) {
    this.renderer = renderer;
    this.cloud = cloud;
    this.radiusPx = options.radiusPx ?? 7;
    this.mesh = new THREE.Mesh(cloud.mesh.geometry, cloud.pickingMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
  }

  /**
   * 画面上の位置（clientX, clientY）に見えている点を返す。真下になければ半径内で最も近い画素の点、
   * 半径内に点がなければ null。
   */
  pick(camera: THREE.PerspectiveCamera, clientX: number, clientY: number): Promise<PickResult | null> {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const { x: bw, y: bh } = this.renderer.getDrawingBufferSize(this.bufferSize);
    if (rect.width <= 0 || rect.height <= 0) return Promise.resolve(null);
    const sx = bw / rect.width;
    const sy = bh / rect.height;
    const px = Math.floor((clientX - rect.left) * sx);
    const py = Math.floor((clientY - rect.top) * sy);
    if (px < 0 || py < 0 || px >= bw || py >= bh) return Promise.resolve(null);

    const scale = (sx + sy) / 2;
    const radius = this.radiusPx * scale; // 描画バッファの画素
    const r = Math.floor(radius);
    const size = 2 * r + 1;
    const x0 = px - r, y0 = py - r;
    const target = (this.target = ensureTarget(this.target, size, size));
    this.renderIds(camera, target, bw, bh, x0, y0, size, size);
    const pixels = new Uint8Array(4 * size * size);
    // 同期部分で readPixels まで発行する（次の描画で上書きされても結果は変わらない）
    const read = this.renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, pixels);
    return read.then(() => {
      const hit = selectNearest({ pixels, size, x0, y0, bufferWidth: bw, bufferHeight: bh }, radius);
      return hit ? { index: hit.index, pixelDistance: hit.distance / scale } : null;
    });
  }

  /** ピッキング用マテリアルで全画面を描き、番号の画像を返す（検証用）。 */
  async readIdImage(camera: THREE.PerspectiveCamera): Promise<IdImage> {
    const { x: bw, y: bh } = this.renderer.getDrawingBufferSize(this.bufferSize);
    const target = (this.fullTarget = ensureTarget(this.fullTarget, bw, bh));
    this.renderIds(camera, target, bw, bh, 0, 0, bw, bh);
    const pixels = new Uint8Array(4 * bw * bh);
    await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, bw, bh, pixels);
    const ids = new Int32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const row = bh - 1 - y;
      for (let x = 0; x < bw; x++) {
        const o = 4 * (row * bw + x);
        ids[y * bw + x] = decodePickId(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
      }
    }
    return { width: bw, height: bh, ids };
  }

  dispose(): void {
    this.target?.dispose();
    this.fullTarget?.dispose();
    this.target = this.fullTarget = null;
    this.scene.remove(this.mesh);
  }

  /**
   * 描画バッファ（bw × bh）のうち、左上 (x, y)・大きさ w × h の範囲を target へ番号で描く。
   * レンダラーの描画先・クリア色・自動クリアは元に戻す。渡されたカメラは変更しない。
   */
  private renderIds(camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget,
    bw: number, bh: number, x: number, y: number, w: number, h: number): void {
    const renderer = this.renderer;
    const cam = this.pickCamera;

    camera.updateMatrixWorld();
    cam.copy(camera, false);
    camera.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    // 元のカメラに view offset があれば、その中の範囲として合成する
    const v = camera.view?.enabled ? camera.view : null;
    if (v) {
      const kx = v.width / bw, ky = v.height / bh;
      cam.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX + x * kx, v.offsetY + y * ky, w * kx, h * ky);
    } else {
      cam.setViewOffset(bw, bh, x, y, w, h);
    }
    cam.updateMatrixWorld();

    this.mesh.matrix.copy(this.cloud.mesh.matrixWorld);
    this.mesh.visible = this.cloud.mesh.visible;
    this.cloud.setPickingViewportHeight(h);

    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevLevel = renderer.getActiveMipmapLevel();
    renderer.getClearColor(this.savedClearColor);
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.render(this.scene, cam);
    } finally {
      renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
      renderer.setClearColor(this.savedClearColor, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
    }
  }
}

function ensureTarget(t: THREE.WebGLRenderTarget | null, w: number, h: number): THREE.WebGLRenderTarget {
  if (t && t.width === w && t.height === h) return t;
  t?.dispose();
  const target = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
    colorSpace: THREE.NoColorSpace,
  });
  return target;
}
