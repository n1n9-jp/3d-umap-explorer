import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { dollyPosition, orbitPose, OVERVIEW_MAX_PITCH } from './overviewControls';

function lookingAt(position: Vector3, target: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, target, new Vector3(0, 1, 0)));
}
const forwardOf = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);

describe('orbitPose', () => {
  const pivot = new Vector3(0.1, -0.2, 0.3);

  it('中心までの距離を保ち、中心の画面上の位置（カメラ座標）も変えない', () => {
    const position = new Vector3(1.2, 0.7, 2.0);
    const quaternion = lookingAt(position, new Vector3(0.5, 0.1, 0)); // 中心を向いていない
    const before = pivot.clone().applyMatrix4(new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1)).invert());
    const next = orbitPose({ position, quaternion }, pivot, 0.7, -0.3);
    const after = pivot.clone().applyMatrix4(new Matrix4().compose(next.position, next.quaternion, new Vector3(1, 1, 1)).invert());
    expect(next.position.distanceTo(pivot)).toBeCloseTo(position.distanceTo(pivot), 9);
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('入力の姿勢を書き換えない', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    orbitPose({ position, quaternion }, new Vector3(), 1, 1);
    expect(position.toArray()).toEqual([0, 0, 2]);
  });

  it('横傾き（roll）を生まない: 右軸は常に水平', () => {
    const position = new Vector3(1, 0.5, 1.5);
    let pose = { position, quaternion: lookingAt(position, new Vector3(0.4, 0.2, 0)) };
    for (const [dy, dp] of [[0.4, 0.2], [-1.1, 0.5], [2.0, -0.9]] as const) {
      pose = orbitPose(pose, pivot, dy, dp);
      expect(new Vector3(1, 0, 0).applyQuaternion(pose.quaternion).y).toBeCloseTo(0, 9);
    }
  });

  it('dYaw が負（右へドラッグ）のとき、カメラは中心の左側へ回り込む', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    const next = orbitPose({ position, quaternion }, new Vector3(), -0.3, 0);
    expect(next.position.x).toBeLessThan(0);
    expect(forwardOf(next.quaternion).x).toBeGreaterThan(0); // 中心の方（右）へ向き直る
  });

  it('dPitch が負（下へドラッグ）のとき、カメラは上がって見下ろす', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    const next = orbitPose({ position, quaternion }, new Vector3(), 0, -0.3);
    expect(next.position.y).toBeGreaterThan(0);
    expect(forwardOf(next.quaternion).y).toBeLessThan(0);
  });

  it('仰角は ±89° を超えない', () => {
    const position = new Vector3(0, 0, 2);
    let pose = { position, quaternion: lookingAt(position, new Vector3()) };
    pose = orbitPose(pose, new Vector3(), 0, 10);
    expect(Math.asin(forwardOf(pose.quaternion).y)).toBeCloseTo(OVERVIEW_MAX_PITCH, 9);
    pose = orbitPose(pose, new Vector3(), 0, -20);
    expect(Math.asin(forwardOf(pose.quaternion).y)).toBeCloseTo(-OVERVIEW_MAX_PITCH, 9);
  });
});

describe('dollyPosition', () => {
  const pivot = new Vector3(0, 0, 0);
  const q = new Quaternion();

  it('距離を倍率で変え、中心から見た向きは変えない', () => {
    const p = dollyPosition(new Vector3(0, 0, 2), q, pivot, 0.5);
    expect(p.toArray()).toEqual([0, 0, 1]);
  });

  it('距離は最小・最大の範囲に収める', () => {
    expect(dollyPosition(new Vector3(0, 0, 2), q, pivot, 1e-9).length()).toBeCloseTo(0.002, 9);
    expect(dollyPosition(new Vector3(0, 0, 2), q, pivot, 1e9).length()).toBeCloseTo(8, 9);
  });

  it('中心と重なっていても、視線の反対側へ離れられる', () => {
    const p = dollyPosition(new Vector3(0, 0, 0), q, pivot, 1.15);
    expect(p.z).toBeGreaterThan(0);
  });
});
