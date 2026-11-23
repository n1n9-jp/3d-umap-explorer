/**
 * 点群に対する近傍検索の空間索引（kd木）。
 *
 * - 構造: 葉に最大 LEAF_SIZE 点を持つ、暗黙の平衡 kd 木。木の各節点は並べ替えた点配列の
 *   範囲 [lo, hi) で表し、範囲の中央の点 mid が分割点になる。左は [lo, mid)、右は [mid+1, hi)。
 *   分割軸は範囲の外接箱で最も長い軸で、節点ごとに `splitAxis[mid]` に持つ。
 *   一様グリッドと違い、密な塊と広い空白が混在する分布でも、問い合わせが O(log N) で済む。
 * - 距離の定義: 座標は Float32 の値を倍精度に広げて計算する（`dx*dx + dy*dy + dz*dz`）。
 *   範囲の判定（maxDistance・radius）は、この二乗距離と `r*r` の比較で、境界を含む（<=）。
 * - 同じ距離の点は、添字の小さい方を先にする。結果は構築や木の形に依らず決まる。
 * - 問い合わせの作業領域（探索スタック・kNearest のヒープ・within の収集用バッファ）は
 *   インスタンスが持ち回して使う。戻り値のオブジェクトと配列だけが問い合わせごとに作られる。
 *   そのため、1 つのインスタンスを複数スレッドや再入的に使う想定ではない
 *   （Web Worker に渡す場合は Worker ごとに構築する）。
 */

/** 葉に入れる最大点数。4・8・16 で 7 万点の計測に有意な差はなく（雑音の範囲）、8 にした。 */
const LEAF_SIZE = 8;

/** 探索スタックの深さ。木の深さは log2(N / LEAF_SIZE) なので、N < 2^31 に対して十分大きい。 */
const STACK_SIZE = 64;

export interface NearestResult {
  index: number;
  distance: number;
}

export interface KNearestResult {
  /** 近い順（同距離は添字の小さい順）の点の添字 */
  indices: Int32Array;
  /** `indices` に対応する距離 */
  distances: Float32Array;
}

export class SpatialIndex {
  readonly count: number;

  /** 木の順に並べ替えた座標のコピー（長さ 3N）。入力の Float32Array とは独立している。 */
  private readonly pts: Float32Array;
  /** 木の順の位置 → 入力での点の添字 */
  private readonly ids: Int32Array;
  /** 位置 mid が分割点のときの分割軸（0:x, 1:y, 2:z） */
  private readonly splitAxis: Uint8Array;

  // 問い合わせの作業領域
  private readonly stackLo = new Int32Array(STACK_SIZE);
  private readonly stackHi = new Int32Array(STACK_SIZE);
  private readonly stackBound = new Float64Array(STACK_SIZE);
  private heapD: Float64Array = new Float64Array(16);
  private heapI: Int32Array = new Int32Array(16);
  private collected: Int32Array = new Int32Array(64);

  /**
   * @param positions 長さ 3N。点 i が [3i, 3i+1, 3i+2] に x, y, z。構築時にコピーするので、
   *   後から書き換えても索引には反映されない。
   */
  constructor(positions: Float32Array) {
    if (positions.length % 3 !== 0) {
      throw new RangeError(`positions の長さは 3 の倍数である必要があります: ${positions.length}`);
    }
    const n = positions.length / 3;
    this.count = n;
    this.pts = new Float32Array(positions);
    this.ids = new Int32Array(n);
    for (let i = 0; i < n; i++) this.ids[i] = i;
    this.splitAxis = new Uint8Array(n);
    this.build();
  }

  /** 最も近い点。`maxDistance` 以内（境界を含む）に点がなければ null。 */
  nearest(x: number, y: number, z: number, maxDistance: number = Infinity): NearestResult | null {
    if (this.count === 0 || !(maxDistance >= 0) || x !== x || y !== y || z !== z) return null;
    const pts = this.pts;
    const ids = this.ids;
    const splitAxis = this.splitAxis;
    const stackLo = this.stackLo;
    const stackHi = this.stackHi;
    const stackBound = this.stackBound;

    let best = maxDistance * maxDistance;
    let bestPos = -1;
    let bestId = -1;
    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > best) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const nodeBound = stackBound[sp];

      while (hi - lo > LEAF_SIZE) {
        const mid = (lo + hi) >> 1;
        const o = mid * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best || (d2 === best && (bestId < 0 || ids[mid] < bestId))) {
          best = d2;
          bestPos = mid;
          bestId = ids[mid];
        }
        const axis = splitAxis[mid];
        const diff = axis === 0 ? dx : axis === 1 ? dy : dz;
        const planeD2 = diff * diff;
        const farBound = planeD2 > nodeBound ? planeD2 : nodeBound;
        if (diff < 0) {
          // 左が近い側。右を後回しにする
          if (farBound <= best) {
            stackLo[sp] = mid + 1;
            stackHi[sp] = hi;
            stackBound[sp] = farBound;
            sp++;
          }
          hi = mid;
        } else {
          if (farBound <= best) {
            stackLo[sp] = lo;
            stackHi[sp] = mid;
            stackBound[sp] = farBound;
            sp++;
          }
          lo = mid + 1;
        }
      }
      for (let i = lo; i < hi; i++) {
        const o = i * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best || (d2 === best && (bestId < 0 || ids[i] < bestId))) {
          best = d2;
          bestPos = i;
          bestId = ids[i];
        }
      }
    }
    if (bestPos < 0) return null;
    return { index: bestId, distance: Math.sqrt(best) };
  }

  /**
   * 近い順に最大 k 個。`maxDistance` 以内（境界を含む）の点だけを対象にする。
   * 同距離の点は添字の小さい順。k が点数を超える場合は、全点（または範囲内の全点）を返す。
   */
  kNearest(
    x: number,
    y: number,
    z: number,
    k: number,
    maxDistance: number = Infinity,
  ): KNearestResult {
    if (!(k >= 1) || this.count === 0 || !(maxDistance >= 0) || x !== x || y !== y || z !== z) {
      return { indices: new Int32Array(0), distances: new Float32Array(0) };
    }
    const cap = Math.min(Math.floor(k), this.count);
    if (this.heapD.length < cap) {
      let size = this.heapD.length;
      while (size < cap) size *= 2;
      this.heapD = new Float64Array(size);
      this.heapI = new Int32Array(size);
    }
    const heapD = this.heapD;
    const heapI = this.heapI;
    const pts = this.pts;
    const ids = this.ids;
    const splitAxis = this.splitAxis;
    const stackLo = this.stackLo;
    const stackHi = this.stackHi;
    const stackBound = this.stackBound;

    // heapD/heapI は最大ヒープ。根が「採用中で最も遠い」点（同距離なら添字が大きい方）。
    let size = 0;
    // これを超える二乗距離の点は不要。ヒープが満杯になったら根の距離に更新する。
    let limit = maxDistance * maxDistance;

    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > limit) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const nodeBound = stackBound[sp];

      while (hi - lo > LEAF_SIZE) {
        const mid = (lo + hi) >> 1;
        const o = mid * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= limit) {
          size = this.heapOffer(size, cap, d2, ids[mid]);
          if (size === cap) limit = heapD[0];
        }
        const axis = splitAxis[mid];
        const diff = axis === 0 ? dx : axis === 1 ? dy : dz;
        const planeD2 = diff * diff;
        const farBound = planeD2 > nodeBound ? planeD2 : nodeBound;
        if (diff < 0) {
          if (farBound <= limit) {
            stackLo[sp] = mid + 1;
            stackHi[sp] = hi;
            stackBound[sp] = farBound;
            sp++;
          }
          hi = mid;
        } else {
          if (farBound <= limit) {
            stackLo[sp] = lo;
            stackHi[sp] = mid;
            stackBound[sp] = farBound;
            sp++;
          }
          lo = mid + 1;
        }
      }
      for (let i = lo; i < hi; i++) {
        const o = i * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= limit) {
          size = this.heapOffer(size, cap, d2, ids[i]);
          if (size === cap) limit = heapD[0];
        }
      }
    }

    // ヒープソート: 根（最遠）を末尾から順に取り出すと昇順に並ぶ。
    const indices = new Int32Array(size);
    const distances = new Float32Array(size);
    for (let out = size - 1; out >= 0; out--) {
      indices[out] = heapI[0];
      distances[out] = Math.sqrt(heapD[0]);
      size--;
      if (size > 0) {
        const d = heapD[size];
        const id = heapI[size];
        this.siftDown(size, d, id);
      }
    }
    return { indices, distances };
  }

  /**
   * 半径 `radius` 以内（境界を含む）の全点の添字。添字の昇順。
   */
  within(x: number, y: number, z: number, radius: number): Int32Array {
    if (this.count === 0 || !(radius >= 0) || x !== x || y !== y || z !== z) {
      return new Int32Array(0);
    }
    const pts = this.pts;
    const ids = this.ids;
    const splitAxis = this.splitAxis;
    const stackLo = this.stackLo;
    const stackHi = this.stackHi;
    const stackBound = this.stackBound;
    const limit = radius * radius;

    let found = 0;
    let buf = this.collected;

    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > limit) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const nodeBound = stackBound[sp];

      while (hi - lo > LEAF_SIZE) {
        const mid = (lo + hi) >> 1;
        const o = mid * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        if (dx * dx + dy * dy + dz * dz <= limit) {
          if (found === buf.length) buf = this.growCollected(buf);
          buf[found++] = ids[mid];
        }
        const axis = splitAxis[mid];
        const diff = axis === 0 ? dx : axis === 1 ? dy : dz;
        const planeD2 = diff * diff;
        const farBound = planeD2 > nodeBound ? planeD2 : nodeBound;
        if (diff < 0) {
          if (farBound <= limit) {
            stackLo[sp] = mid + 1;
            stackHi[sp] = hi;
            stackBound[sp] = farBound;
            sp++;
          }
          hi = mid;
        } else {
          if (farBound <= limit) {
            stackLo[sp] = lo;
            stackHi[sp] = mid;
            stackBound[sp] = farBound;
            sp++;
          }
          lo = mid + 1;
        }
      }
      for (let i = lo; i < hi; i++) {
        const o = i * 3;
        const dx = x - pts[o];
        const dy = y - pts[o + 1];
        const dz = z - pts[o + 2];
        if (dx * dx + dy * dy + dz * dz <= limit) {
          if (found === buf.length) buf = this.growCollected(buf);
          buf[found++] = ids[i];
        }
      }
    }
    const result = buf.slice(0, found);
    result.sort();
    return result;
  }

  // ---------------------------------------------------------------- kNearest のヒープ

  /** 点 (d2, id) をヒープに入れる。満杯なら、根（最遠）より近い場合だけ入れ替える。 */
  private heapOffer(size: number, cap: number, d2: number, id: number): number {
    const heapD = this.heapD;
    const heapI = this.heapI;
    if (size < cap) {
      // 末尾に追加して上へ
      let i = size;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        const pd = heapD[parent];
        if (pd > d2 || (pd === d2 && heapI[parent] > id)) break;
        heapD[i] = pd;
        heapI[i] = heapI[parent];
        i = parent;
      }
      heapD[i] = d2;
      heapI[i] = id;
      return size + 1;
    }
    const rd = heapD[0];
    if (d2 < rd || (d2 === rd && id < heapI[0])) this.siftDown(size, d2, id);
    return size;
  }

  /** 根を (d2, id) で置き換え、ヒープ（大きさ size）の条件を満たす位置まで下げる。 */
  private siftDown(size: number, d2: number, id: number): void {
    const heapD = this.heapD;
    const heapI = this.heapI;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      const right = child + 1;
      if (
        right < size &&
        (heapD[right] > heapD[child] || (heapD[right] === heapD[child] && heapI[right] > heapI[child]))
      ) {
        child = right;
      }
      const cd = heapD[child];
      if (cd < d2 || (cd === d2 && heapI[child] < id)) break;
      heapD[i] = cd;
      heapI[i] = heapI[child];
      i = child;
    }
    heapD[i] = d2;
    heapI[i] = id;
  }

  private growCollected(buf: Int32Array): Int32Array {
    const bigger = new Int32Array(buf.length * 2);
    bigger.set(buf);
    this.collected = bigger;
    return bigger;
  }

  // ---------------------------------------------------------------- 構築

  private build(): void {
    const n = this.count;
    if (n <= LEAF_SIZE) return;
    // 再帰ではなく明示スタックで範囲を処理する（深さは高々 log2(N)）。
    const lo = new Int32Array(STACK_SIZE);
    const hi = new Int32Array(STACK_SIZE);
    let sp = 0;
    lo[0] = 0;
    hi[0] = n;
    sp = 1;
    const pts = this.pts;
    while (sp > 0) {
      sp--;
      const l = lo[sp];
      const h = hi[sp];
      if (h - l <= LEAF_SIZE) continue;

      // 外接箱で最も長い軸
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = l, o = l * 3; i < h; i++, o += 3) {
        const px = pts[o], py = pts[o + 1], pz = pts[o + 2];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;

      const mid = (l + h) >> 1;
      this.select(mid, l, h - 1, axis);
      this.splitAxis[mid] = axis;

      lo[sp] = l;
      hi[sp] = mid;
      sp++;
      lo[sp] = mid + 1;
      hi[sp] = h;
      sp++;
    }
  }

  /**
   * 位置 [left, right]（両端を含む）を軸 axis の値で部分的に整列し、位置 k に k 番目の値が来て、
   * 左は k 以下、右は k 以上になるようにする（クイックセレクト、3 点の中央値を軸にする）。
   * 値が重複する入力でも、等しい値で止まって交換するので、範囲が偏らない。
   */
  private select(k: number, left: number, right: number, axis: number): void {
    const pts = this.pts;
    while (right > left) {
      const m = (left + right) >> 1;
      const a = pts[left * 3 + axis];
      const b = pts[m * 3 + axis];
      const c = pts[right * 3 + axis];
      const pivot =
        a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
      let i = left;
      let j = right;
      while (i <= j) {
        while (pts[i * 3 + axis] < pivot) i++;
        while (pts[j * 3 + axis] > pivot) j--;
        if (i <= j) {
          this.swap(i, j);
          i++;
          j--;
        }
      }
      if (k <= j) right = j;
      else if (k >= i) left = i;
      else return;
    }
  }

  private swap(i: number, j: number): void {
    if (i === j) return;
    const pts = this.pts;
    const ids = this.ids;
    const a = i * 3;
    const b = j * 3;
    const x = pts[a], y = pts[a + 1], z = pts[a + 2];
    pts[a] = pts[b];
    pts[a + 1] = pts[b + 1];
    pts[a + 2] = pts[b + 2];
    pts[b] = x;
    pts[b + 1] = y;
    pts[b + 2] = z;
    const t = ids[i];
    ids[i] = ids[j];
    ids[j] = t;
  }
}
