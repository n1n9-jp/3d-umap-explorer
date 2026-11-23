import * as THREE from 'three';
import { cellOrigins, atlasLayout, inkIsDark } from './data/atlas';
import { loadAtlasImage, loadDatasetArrays, measureBorderLuma } from './data/loader';
import { PointCloud } from './render/pointCloud';
import { BACKGROUND_COLOR } from './render/palette';
import { fogForCamera } from './render/fog';
import { formatView, parsePositiveNumber, parseView, type ViewSpec } from './render/view';
import { CameraRig, type CameraState } from './app/cameraRig';
import { formatHud } from './app/hud';
import { GpuPicker, type PickResult } from './picking/GpuPicker';
import { createPickingDebug, type PickingDebug } from './picking/debug';
import { SpatialIndex } from './spatial/SpatialIndex';
import { AutoSpeed, autoSpeedParams } from './app/autoSpeed';
import { bindAutoSpeedKey } from './app/autoSpeedKey';
import { computeHomeView } from './app/homeView';
import { bindShortcut, isShortcutPress, isFromEditable } from './app/keyEvents';

interface FrameStats { frames: number; meanMs: number; medianMs: number; p95Ms: number; maxMs: number }

declare global {
  interface Window {
    __explorer?: {
      ready: boolean;
      error?: string;
      setView(view: ViewSpec): void;
      /** いまの画面の縦横比での、点群全体が収まるホームの視点（H キーの移動先、起動時の視点）。 */
      homeView(): ViewSpec;
      /** 現在のモード・位置・注視点・速度・速度の自動調整の状態。 */
      getState(): CameraState;
      measureFrames(n: number): Promise<FrameStats>;
      pointCloud: PointCloud;
      /** 画面上の位置（CSS ピクセル）に見えている点 */
      pick(clientX: number, clientY: number): Promise<PickResult | null>;
      /** ピッキングの検証用の補助 */
      picking: PickingDebug;
    };
  }
}

const INTERIOR_FOG: [number, number, number] = [0.15, 0.9, 0.75];

async function start(): Promise<void> {
  const container = document.getElementById('app')!;
  const hud = document.getElementById('hud')!;
  const search = window.location.search;
  const dataUrl = new URLSearchParams(search).get('data') ?? 'data/mnist/';

  THREE.ColorManagement.enabled = false; // シェーダは sRGB の値をそのまま出力する

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(new THREE.Color(BACKGROUND_COLOR), 1);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // 密な領域の最近傍点間距離は 0.003〜0.01 程度。近接クリップ面はそれより十分小さくする
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.0005, 12);

  const [arrays, image] = await (async () => {
    const a = await loadDatasetArrays(dataUrl);
    return [a, await loadAtlasImage(dataUrl, a.manifest)] as const;
  })();
  const layout = atlasLayout(arrays.manifest.sprite, image.width, image.height);
  const sizeParam = parsePositiveNumber(search, 'size');

  const cloud = new PointCloud(
    {
      positions: arrays.positions,
      labels: arrays.labels,
      cellOrigins: cellOrigins(arrays.manifest.count, layout),
      cellSize: [layout.cellU, layout.cellV],
      labelCount: arrays.manifest.labels.names.length,
      atlas: image,
      inkIsDark: inkIsDark(measureBorderLuma(image)),
    },
    { fog: INTERIOR_FOG, ...(sizeParam ? { pointSize: sizeParam } : {}) },
  );
  scene.add(cloud.mesh);

  // 点群の中心（バウンディングボックスの中心）。俯瞰モードの回転の中心になる
  const cloudCenter = new THREE.Vector3(...arrays.bounds.min).add(new THREE.Vector3(...arrays.bounds.max)).multiplyScalar(0.5);
  // 点群を含む球の中心。霧の距離の基準になる（俯瞰モードの回転の中心とは別）
  const boundsCenter = new THREE.Vector3(...arrays.bounds.center);
  // 密度に応じた速度の自動調整（manifest に density がなければ使わない）
  const autoParams = autoSpeedParams(arrays.manifest.density);
  const autoSpeed = autoParams ? new AutoSpeed(new SpatialIndex(arrays.positions), autoParams) : null;
  const controller = new CameraRig(camera, renderer.domElement, cloudCenter, { autoSpeed });
  bindAutoSpeedKey(window, controller); // T キーで有効・無効を切り替える
  // ホームの視点: 点群全体（bounds の球）が画面に収まる位置。向きは manifest の overview.axes（第3軸の方向から見る）
  const homeView = () => computeHomeView(arrays.bounds, camera.fov, camera.aspect, arrays.manifest.overview?.axes);
  bindShortcut(window, 'KeyH', () => controller.goHome(homeView())); // H キーでホームの視点へ戻る
  controller.setView(parseView(search, homeView())); // pos・look がなければホームの視点から始める

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    cloud.setViewportHeight(renderer.getDrawingBufferSize(new THREE.Vector2()).y);
  };
  window.addEventListener('resize', resize);
  resize();

  // 点の大きさを [ ] キーで変える
  window.addEventListener('keydown', (e) => {
    if ((e.key === '[' || e.key === ']') && !isFromEditable(e)) {
      const k = e.key === ']' ? 1.25 : 0.8;
      cloud.set({ pointSize: Math.min(0.1, Math.max(0.0005, cloud.params.pointSize * k)) });
    }
  });

  // O キーで飛行モードと俯瞰モードを切り替える
  window.addEventListener('keydown', (e) => {
    if (isShortcutPress(e, 'KeyO')) controller.toggle();
  });

  const updateHud = () => {
    const s = controller.getState();
    hud.textContent = formatHud({
      datasetName: arrays.manifest.name,
      pointCount: arrays.manifest.count,
      pointSize: cloud.params.pointSize,
      mode: s.mode,
      speed: s.speed,
      autoSpeed: { available: s.autoSpeed.available, enabled: s.autoSpeed.enabled, effectiveSpeed: s.effectiveSpeed },
      viewParams: formatView({ pos: s.position, look: s.lookAt }),
    });
  };
  controller.onChange(() => updateHud()); // モードと速度の変化はすぐに見せる

  let frameTimes: number[] | null = null;
  let frameWanted = 0;
  let frameArmed = false;
  let frameResolve: ((s: FrameStats) => void) | null = null;
  let last = performance.now();
  let hudTimer = 0;

  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    if (frameTimes && frameArmed) {
      frameTimes.push(now - last);
      if (frameTimes.length >= frameWanted && frameResolve) {
        const s = [...frameTimes].sort((a, b) => a - b);
        const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
        frameResolve({
          frames: s.length,
          meanMs: s.reduce((a, b) => a + b, 0) / s.length,
          medianMs: pick(0.5),
          p95Ms: pick(0.95),
          maxMs: s[s.length - 1] as number,
        });
        frameTimes = null;
        frameResolve = null;
      }
    }
    frameArmed = frameTimes !== null; // 計測要求の直後のフレームは区間が不完全なので数えない
    last = now;

    controller.update(dt);
    cloud.set({ fog: fogForCamera(camera.position.distanceTo(boundsCenter), arrays.bounds.radius, INTERIOR_FOG) });
    renderer.render(scene, camera);

    hudTimer += dt;
    if (hudTimer > 0.25) { hudTimer = 0; updateHud(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  updateHud();

  // ---- ピッキング（src/picking/）----
  const picker = new GpuPicker(renderer, cloud);
  const picking = createPickingDebug(renderer, scene, camera, cloud, picker);
  // ---- ここまで ----

  window.__explorer = {
    ready: true,
    pick: (x, y) => picker.pick(camera, x, y),
    picking,
    setView: (v) => controller.setView(v),
    homeView,
    getState: () => controller.getState(),
    measureFrames: (n) =>
      new Promise((resolve) => {
        frameTimes = [];
        frameArmed = false;
        frameWanted = n;
        frameResolve = resolve;
      }),
    pointCloud: cloud,
  };
}

start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) { hud.textContent = `読み込みに失敗しました: ${message}`; hud.classList.add('error'); }
  window.__explorer = { ready: false, error: message } as Window['__explorer'];
});
