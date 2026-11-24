/**
 * 点群に対する近傍検索の空間索引（kd木）。
 *
 * - 構造: 葉に最大 LEAF_SIZE 点を持つ、暗黙の平衡 kd 木。木の各節点は並べ替えた点配列の
 *   範囲 [lo, hi) で表し、範囲の中央の点 mid が分割点になる。左は [lo, mid)、右は [mid+1, hi)。
 *   分割軸は範囲の外接箱で最も長い軸で、節点ごとに `splitAxis[mid]` に持つ。
 *   一様グリッドと違い、密な塊と広い空白が混在する分布でも、問い合わせが O(log N) で済む。
 * - 距離の定義: 座標は Float32 の値を倍精度に広げて計算する（`dx*dx + dy*dy + dz*dz`）。
 *   範囲の判定（maxDistance・radius）は、この二乗距離と `r*r` の比較で、境界を含む（<=）。
 * - 枝刈り: 遠い側の子へ降りるかは、その子の範囲の点までの二乗距離の下限で決める。下限は 2 段で作る。
 *   (1) 軸ごとのずれの二乗和。問い合わせ点から、分割面で切った領域（kd 木の節点の箱）までの軸ごとの
 *   ずれを持ち、分割面を越えて遠い側へ降りるたびに、その分割軸のずれだけを「分割面までの差」に
 *   差し替える増分計算で、メモリを読まずに求まる。分割面 1 枚までの距離だけで判断するより厳しい。
 *   (2) (1) で刈れなかったときだけ、遠い側の範囲の点の外接箱（`boxes`）までの距離で締める。
 *   領域は外側へ無限に伸びているので、点が小さな塊に分かれた分布では (1) だけでは、塊から離れた
 *   問い合わせ（特に点群の外側）で多くの節点を訪れる。外接箱は領域に収まるので、(2) は (1) 以上になる。
 *   どちらの下限も、点の二乗距離と同じ式・同じ足し順で作るので、浮動小数点の丸めでも範囲内の点の
 *   二乗距離を超えない（境界の点を誤って刈ることはない）。
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

/**
 * 構築済みの索引の中身（`SpatialIndex.toData` で取り出し、`new SpatialIndex(positions, data)` で戻す）。
 * Web Worker で構築して、配列を transfer でメインスレッドへ渡し、構築をやり直さずに使うためのもの。
 */
export interface SpatialIndexData {
  count: number;
  /** 木の順に並べ替えた座標（長さ 3N） */
  pts: Float32Array;
  /** 木の順の位置 → 入力での点の添字 */
  ids: Int32Array;
  splitAxis: Uint8Array;
  /** 範囲ごとの点の外接箱（長さ 6N） */
  boxes: Float32Array;
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
  /**
   * 範囲ごとの点の外接箱（Float32 で 6 要素: minX, minY, minZ, maxX, maxY, maxZ）。
   * 範囲 [lo, hi) の箱は、その中央 (lo + hi) >> 1 の位置の `6 * 位置` から入る
   * （範囲どうしは重ならないので、位置が衝突しない）。
   */
  private readonly boxes: Float32Array;

  // 問い合わせの作業領域
  private readonly stackLo = new Int32Array(STACK_SIZE);
  private readonly stackHi = new Int32Array(STACK_SIZE);
  /** 積んだ範囲の領域までの二乗距離の下限 */
  private readonly stackBound = new Float64Array(STACK_SIZE);
  /** 積んだ範囲の領域までの、軸ごとのずれ（問い合わせ点から領域の箱までの符号付きの差。箱の内側なら 0） */
  private readonly stackOffX = new Float64Array(STACK_SIZE);
  private readonly stackOffY = new Float64Array(STACK_SIZE);
  private readonly stackOffZ = new Float64Array(STACK_SIZE);
  /** `forEachInBoxes` 専用のスタック（`mayContain` と `visit` の中から `nearest` / `kNearest` / `within` を呼んでも、巡回の途中の状態を壊さない） */
  private readonly boxStackLo = new Int32Array(STACK_SIZE);
  private readonly boxStackHi = new Int32Array(STACK_SIZE);
  /** `forEachInBoxes` の巡回の最中か（`mayContain` / `visit` の中から `forEachInBoxes` を入れ子で呼ぶときは、専用のスタックが使えないので別に用意する） */
  private boxWalking = false;
  private heapD: Float64Array = new Float64Array(16);
  private heapI: Int32Array = new Int32Array(16);
  private collected: Int32Array = new Int32Array(64);

  /**
   * @param positions 長さ 3N。点 i が [3i, 3i+1, 3i+2] に x, y, z。構築時にコピーするので、
   *   後から書き換えても索引には反映されない。NaN を含む場合は RangeError（NaN があると木の分割の
   *   前提が崩れ、正常な点の検索結果まで誤るため）。±Infinity は受け付ける。
   * @param prebuilt 同じ `positions` から構築済みの索引の中身（`toData()` の結果）。渡すと構築しない
   *   （配列は索引のものになる。座標の NaN の検査と、座標のコピーも省く）。長さが合わなければ RangeError。
   */
  constructor(positions: Float32Array, prebuilt?: SpatialIndexData) {
    if (positions.length % 3 !== 0) {
      throw new RangeError(`positions の長さは 3 の倍数である必要があります: ${positions.length}`);
    }
    if (prebuilt) {
      const n = positions.length / 3;
      if (
        prebuilt.count !== n || prebuilt.pts.length !== 3 * n || prebuilt.ids.length !== n
        || prebuilt.splitAxis.length !== n || prebuilt.boxes.length !== 6 * n
      ) {
        throw new RangeError(`構築済みの索引の大きさが、点の数 ${n} と一致しません`);
      }
      this.count = n;
      this.pts = prebuilt.pts;
      this.ids = prebuilt.ids;
      this.splitAxis = prebuilt.splitAxis;
      this.boxes = prebuilt.boxes;
      return;
    }
    for (let i = 0; i < positions.length; i++) {
      if (positions[i] !== positions[i]) {
        throw new RangeError(`positions に NaN が含まれています: 点 ${Math.floor(i / 3)} の ${'xyz'[i % 3]} 座標`);
      }
    }
    const n = positions.length / 3;
    this.count = n;
    this.pts = new Float32Array(positions);
    this.ids = new Int32Array(n);
    for (let i = 0; i < n; i++) this.ids[i] = i;
    this.splitAxis = new Uint8Array(n);
    this.boxes = new Float32Array(6 * n);
    this.build();
  }

  /**
   * 索引の中身（コピーしない）。Worker から transfer で渡すときに使う。渡したあとは、この索引を使わない。
   */
  toData(): SpatialIndexData {
    return { count: this.count, pts: this.pts, ids: this.ids, splitAxis: this.splitAxis, boxes: this.boxes };
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
    const stackOffX = this.stackOffX;
    const stackOffY = this.stackOffY;
    const stackOffZ = this.stackOffZ;

    let best = maxDistance * maxDistance;
    let bestPos = -1;
    let bestId = -1;
    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    stackOffX[0] = 0;
    stackOffY[0] = 0;
    stackOffZ[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > best) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const ox = stackOffX[sp];
      const oy = stackOffY[sp];
      const oz = stackOffZ[sp];

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
        // 遠い側の子の領域までのずれ: 分割軸のずれだけを分割面までの差に差し替える
        // （近い側の子は、この節点と同じずれのまま）。下限は、軸ごとのずれの二乗和。
        // 無限大どうしの差で下限が NaN になっても刈らないよう、刈る条件は `下限 > 上限` の否定で書く。
        const fx = axis === 0 ? diff : ox;
        const fy = axis === 1 ? diff : oy;
        const fz = axis === 2 ? diff : oz;
        let farBound = fx * fx + fy * fy + fz * fz;
        // diff < 0 なら左が近い側。遠い側の範囲を後回しにし、近い側へ降りる
        let farLo: number;
        let farHi: number;
        if (diff < 0) {
          farLo = mid + 1;
          farHi = hi;
          hi = mid;
        } else {
          farLo = lo;
          farHi = mid;
          lo = mid + 1;
        }
        // 先に軸ごとのずれの下限で足切りし、残ったときだけ、遠い側の点の外接箱までの距離で締める
        if (!(farBound > best)) {
          const boxD2 = this.boxDistance2(x, y, z, farLo, farHi);
          if (boxD2 > farBound) farBound = boxD2;
          if (!(farBound > best)) {
            stackLo[sp] = farLo;
            stackHi[sp] = farHi;
            stackBound[sp] = farBound;
            stackOffX[sp] = fx;
            stackOffY[sp] = fy;
            stackOffZ[sp] = fz;
            sp++;
          }
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
    const stackOffX = this.stackOffX;
    const stackOffY = this.stackOffY;
    const stackOffZ = this.stackOffZ;

    // heapD/heapI は最大ヒープ。根が「採用中で最も遠い」点（同距離なら添字が大きい方）。
    let size = 0;
    // これを超える二乗距離の点は不要。ヒープが満杯になったら根の距離に更新する。
    let limit = maxDistance * maxDistance;

    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    stackOffX[0] = 0;
    stackOffY[0] = 0;
    stackOffZ[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > limit) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const ox = stackOffX[sp];
      const oy = stackOffY[sp];
      const oz = stackOffZ[sp];

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
        // 遠い側の子の領域までのずれ: 分割軸のずれだけを分割面までの差に差し替える
        // （近い側の子は、この節点と同じずれのまま）。下限は、軸ごとのずれの二乗和。
        // 無限大どうしの差で下限が NaN になっても刈らないよう、刈る条件は `下限 > 上限` の否定で書く。
        const fx = axis === 0 ? diff : ox;
        const fy = axis === 1 ? diff : oy;
        const fz = axis === 2 ? diff : oz;
        let farBound = fx * fx + fy * fy + fz * fz;
        // diff < 0 なら左が近い側。遠い側の範囲を後回しにし、近い側へ降りる
        let farLo: number;
        let farHi: number;
        if (diff < 0) {
          farLo = mid + 1;
          farHi = hi;
          hi = mid;
        } else {
          farLo = lo;
          farHi = mid;
          lo = mid + 1;
        }
        // 先に軸ごとのずれの下限で足切りし、残ったときだけ、遠い側の点の外接箱までの距離で締める
        if (!(farBound > limit)) {
          const boxD2 = this.boxDistance2(x, y, z, farLo, farHi);
          if (boxD2 > farBound) farBound = boxD2;
          if (!(farBound > limit)) {
            stackLo[sp] = farLo;
            stackHi[sp] = farHi;
            stackBound[sp] = farBound;
            stackOffX[sp] = fx;
            stackOffY[sp] = fy;
            stackOffZ[sp] = fz;
            sp++;
          }
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
    const stackOffX = this.stackOffX;
    const stackOffY = this.stackOffY;
    const stackOffZ = this.stackOffZ;
    const limit = radius * radius;

    let found = 0;
    let buf = this.collected;

    let sp = 0;
    stackLo[0] = 0;
    stackHi[0] = this.count;
    stackBound[0] = 0;
    stackOffX[0] = 0;
    stackOffY[0] = 0;
    stackOffZ[0] = 0;
    sp = 1;

    while (sp > 0) {
      sp--;
      if (stackBound[sp] > limit) continue;
      let lo = stackLo[sp];
      let hi = stackHi[sp];
      const ox = stackOffX[sp];
      const oy = stackOffY[sp];
      const oz = stackOffZ[sp];

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
        // 遠い側の子の領域までのずれ: 分割軸のずれだけを分割面までの差に差し替える
        // （近い側の子は、この節点と同じずれのまま）。下限は、軸ごとのずれの二乗和。
        // 無限大どうしの差で下限が NaN になっても刈らないよう、刈る条件は `下限 > 上限` の否定で書く。
        const fx = axis === 0 ? diff : ox;
        const fy = axis === 1 ? diff : oy;
        const fz = axis === 2 ? diff : oz;
        let farBound = fx * fx + fy * fy + fz * fz;
        // diff < 0 なら左が近い側。遠い側の範囲を後回しにし、近い側へ降りる
        let farLo: number;
        let farHi: number;
        if (diff < 0) {
          farLo = mid + 1;
          farHi = hi;
          hi = mid;
        } else {
          farLo = lo;
          farHi = mid;
          lo = mid + 1;
        }
        // 先に軸ごとのずれの下限で足切りし、残ったときだけ、遠い側の点の外接箱までの距離で締める
        if (!(farBound > limit)) {
          const boxD2 = this.boxDistance2(x, y, z, farLo, farHi);
          if (boxD2 > farBound) farBound = boxD2;
          if (!(farBound > limit)) {
            stackLo[sp] = farLo;
            stackHi[sp] = farHi;
            stackBound[sp] = farBound;
            stackOffX[sp] = fx;
            stackOffY[sp] = fy;
            stackOffZ[sp] = fz;
            sp++;
          }
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

  /**
   * ある領域の中にある点だけを調べるための木の巡回。範囲の外接箱を `mayContain` に渡し、false なら、その範囲の点は領域の外として
   * 丸ごと飛ばす。true の範囲は、葉まで降りて、点を木の順に `visit(添字, x, y, z)` へ渡す
   * （`visit` に渡す点は領域の外のものを含むので、呼び出し側が点ごとに判定する）。
   * `mayContain` は保守的でよい（領域と交わる箱には必ず true を返す。交わらない箱への true は、巡回が増えるだけで結果は変わらない）。
   * 座標は構築時の Float32 の値（`positions` と同じ）。
   */
  forEachInBoxes(
    mayContain: (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean,
    visit: (id: number, x: number, y: number, z: number) => void,
  ): void {
    const n = this.count;
    if (n === 0) return;
    const pts = this.pts;
    const ids = this.ids;
    if (n <= LEAF_SIZE) {
      for (let i = 0, o = 0; i < n; i++, o += 3) visit(ids[i], pts[o], pts[o + 1], pts[o + 2]);
      return;
    }
    const boxes = this.boxes;
    const nested = this.boxWalking;
    const stackLo = nested ? new Int32Array(STACK_SIZE) : this.boxStackLo;
    const stackHi = nested ? new Int32Array(STACK_SIZE) : this.boxStackHi;
    this.boxWalking = true;
    try {
      stackLo[0] = 0;
      stackHi[0] = n;
      let sp = 1;
      while (sp > 0) {
        sp--;
        const lo = stackLo[sp];
        const hi = stackHi[sp];
        const mid = (lo + hi) >> 1;
        const b = mid * 6;
        if (!mayContain(boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3], boxes[b + 4], boxes[b + 5])) continue;
        if (hi - lo <= LEAF_SIZE) {
          for (let i = lo, o = lo * 3; i < hi; i++, o += 3) visit(ids[i], pts[o], pts[o + 1], pts[o + 2]);
          continue;
        }
        const o = mid * 3;
        visit(ids[mid], pts[o], pts[o + 1], pts[o + 2]);
        stackLo[sp] = lo;
        stackHi[sp] = mid;
        stackLo[sp + 1] = mid + 1;
        stackHi[sp + 1] = hi;
        sp += 2;
      }
    } finally {
      this.boxWalking = nested;
    }
  }

  /**
   * 点 (x, y, z) から、範囲 [lo, hi) の点の外接箱までの二乗距離（箱の内側なら 0）。
   * 範囲内のどの点の二乗距離（`dx*dx + dy*dy + dz*dz`）も、これ以上になる。
   * 軸ごとの差は点の距離と同じ計算（Float32 の値を倍精度で引く）で、足す順も同じなので、
   * 浮動小数点の丸めでも箱の中の点を下回らない。
   */
  private boxDistance2(x: number, y: number, z: number, lo: number, hi: number): number {
    const boxes = this.boxes;
    const b = ((lo + hi) >> 1) * 6;
    const minX = boxes[b];
    const minY = boxes[b + 1];
    const minZ = boxes[b + 2];
    const maxX = boxes[b + 3];
    const maxY = boxes[b + 4];
    const maxZ = boxes[b + 5];
    const dx = x < minX ? x - minX : x > maxX ? x - maxX : 0;
    const dy = y < minY ? y - minY : y > maxY ? y - maxY : 0;
    const dz = z < minZ ? z - minZ : z > maxZ ? z - maxZ : 0;
    return dx * dx + dy * dy + dz * dz;
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
      // 葉を含む全ての範囲の外接箱を、範囲の中央の位置に記録する（問い合わせの枝刈り用）
      const boxes = this.boxes;
      const b = ((l + h) >> 1) * 6;
      boxes[b] = minX;
      boxes[b + 1] = minY;
      boxes[b + 2] = minZ;
      boxes[b + 3] = maxX;
      boxes[b + 4] = maxY;
      boxes[b + 5] = maxZ;
      if (h - l <= LEAF_SIZE) continue;

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
