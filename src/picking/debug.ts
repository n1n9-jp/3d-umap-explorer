import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import type { GpuPicker, IdImage } from './GpuPicker';

/** 点の画面上の位置と大きさ（検証用）。 */
export interface ProjectedPoint {
  /** 点の中心の画面上の位置（CSS ピクセル） */
  clientX: number;
  clientY: number;
  /** ビルボード1辺の画面上の大きさ（CSS ピクセル。最小サイズでの下支えを含む） */
  sizePx: number;
  /** カメラからの距離（ワールド単位） */
  distance: number;
  /** ビュー空間の奥行き（正ならカメラの前） */
  depth: number;
  /** 近接フェードで完全に消えている（距離が消える距離以下） */
  faded: boolean;
}

export interface PickingDebug {
  /** ピッキング用マテリアルで全画面を描いた番号の画像 */
  readIdImage(): Promise<IdImage>;
  /** 通常の描画を1回行い、画面の描画バッファの画素を返す（RGBA8、上の行から） */
  readFrame(): { width: number; height: number; rgba: Uint8Array };
  /** 点 index の画面上の位置と大きさ */
  project(index: number): ProjectedPoint;
  /** 点の数 */
  count: number;
  /** 描画バッファの画素 / CSS ピクセル */
  bufferScale(): number;
}

/** 検証スクリプト（scripts/verify/picking.cjs）向けの補助。アプリの動作には使わない。 */
export function createPickingDebug(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  camera: THREE.PerspectiveCamera, cloud: PointCloud, picker: GpuPicker): PickingDebug {
  const positions = cloud.mesh.geometry.getAttribute('instancePosition') as THREE.BufferAttribute;
  const size = new THREE.Vector2();
  const v = new THREE.Vector4();
  return {
    readIdImage: () => picker.readIdImage(camera),
    readFrame: () => {
      // 描画先は切り替えない（ピッキングが描画先を戻し忘れていれば、ここで差が出る）
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const raw = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const rgba = new Uint8Array(raw.length);
      for (let y = 0; y < h; y++) rgba.set(raw.subarray(4 * w * (h - 1 - y), 4 * w * (h - y)), 4 * w * y);
      return { width: w, height: h, rgba };
    },
    project: (index) => {
      camera.updateMatrixWorld();
      const p = cloud.params;
      v.set(positions.getX(index), positions.getY(index), positions.getZ(index), 1)
        .applyMatrix4(cloud.mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      const distance = Math.hypot(v.x, v.y, v.z);
      const depth = -v.z;
      const bh = renderer.getDrawingBufferSize(size).y;
      const pxPerUnit = 0.5 * bh * camera.projectionMatrix.elements[5]! / Math.max(depth, 1e-6);
      const shown = Math.max(p.pointSize * pxPerUnit, cloud.minPixelSizeInBuffer());
      v.applyMatrix4(camera.projectionMatrix);
      const rect = renderer.domElement.getBoundingClientRect();
      const scale = bh / rect.height;
      return {
        clientX: rect.left + (v.x / v.w + 1) / 2 * rect.width,
        clientY: rect.top + (1 - v.y / v.w) / 2 * rect.height,
        sizePx: shown / scale,
        distance,
        depth,
        faded: distance <= p.nearFadeFactors[0] * p.pointSize,
      };
    },
    count: positions.count,
    bufferScale: () => renderer.getDrawingBufferSize(size).y / renderer.domElement.getBoundingClientRect().height,
  };
}
