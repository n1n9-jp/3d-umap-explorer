/**
 * 文字の画像（アルファ）から SDF（符号付き距離場）を作る。DOM に依存しない。
 *
 * 方式は @mapbox/tiny-sdf（BSD-2）と同じ。アンチエイリアスされた輪郭の画素は、アルファから輪郭までの
 * 距離を見積もり（0.5 を輪郭とする）、Felzenszwalb と Huttenlocher の 2 次元ユークリッド距離変換で
 * 「外側の画素から最も近いインクまで」と「内側の画素から最も近い外側まで」の距離を求め、差を取る。
 *
 * 出力は 0..255 で、255 - 255 * (d / radius + cutoff)。d は符号付き距離（インクの内側で負、画素単位）。
 * 輪郭（d = 0）は 255 * (1 - cutoff)。外側は radius * (1 - cutoff) 画素先で 0、内側は radius * cutoff 画素で 255。
 */

const INF = 1e20;

/** 1 次元の二乗距離変換（grid の offset から stride ごとに length 個を、その場で書き換える）。 */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number,
  f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    const qr = q - r;
    grid[offset + q * stride] = f[r]! + qr * qr;
  }
}

/** 2 次元の二乗距離変換（列ごと、行ごとの順に 1 次元の変換を重ねる）。 */
export function edt2d(grid: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/**
 * アルファ（0..255、行優先）から SDF（0..255）を作る。
 * @param radius 距離の幅（画素）。大きいほど遠くまで距離を表せるが、精度は下がる
 * @param cutoff 輪郭の位置（0..1）。0.25 なら輪郭が 191 付近、外側に radius の 3/4 まで表せる
 */
export function alphaToSdf(alpha: ArrayLike<number>, width: number, height: number, radius: number, cutoff: number): Uint8ClampedArray {
  const size = width * height;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = alpha[i]! / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a; // 輪郭（0.5）までの距離の見積もり（画素）
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt2d(outer, width, height);
  edt2d(inner, width, height);
  const out = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i++) {
    const d = Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!);
    out[i] = Math.round(255 - 255 * (d / radius + cutoff));
  }
  return out;
}
