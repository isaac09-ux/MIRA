// ============================================================
//  MIRA · homography.js
//  Resuelve la matriz de homografía 3x3 a partir de 4 pares de
//  puntos, en JavaScript puro. Equivalente a cv2.findHomography
//  para el caso exacto de 4 correspondencias (DLT).
//  El motor de CLARA (Python) consume el cal.json que sale de aquí.
// ============================================================

// Resuelve un sistema lineal A·x = b por eliminación gaussiana
// con pivoteo parcial. A es n×n (array de arrays), b es n.
function solveLinear(A, b) {
  const n = b.length;
  // Matriz aumentada
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Pivoteo parcial: fila con mayor valor absoluto en esta columna
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error("Sistema singular — los 4 puntos no forman un cuadrilátero válido.");
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];

    // Eliminación
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }
  // Solución
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Calcula la homografía que mapea src → dst.
 * @param {Array<[number,number]>} src - 4 puntos origen (píxeles)
 * @param {Array<[number,number]>} dst - 4 puntos destino (coords cancha)
 * @returns {number[][]} matriz 3x3
 */
export function computeHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error("Se requieren exactamente 4 puntos en src y dst.");
  }
  // Cada correspondencia (x,y)→(u,v) aporta 2 ecuaciones.
  // Incógnitas: h0..h7  (h8 fijado a 1).
  //   h0·x + h1·y + h2 - h6·x·u - h7·y·u = u
  //   h3·x + h4·y + h5 - h6·x·v - h7·y·v = v
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

/**
 * Proyecta un punto (x,y) a través de una homografía H.
 * @returns {[number,number]}
 */
export function projectPoint(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  const u = (H[0][0] * x + H[0][1] * y + H[0][2]) / w;
  const v = (H[1][0] * x + H[1][1] * y + H[1][2]) / w;
  return [u, v];
}

/**
 * Invierte una matriz 3x3 (para proyectar de cancha → píxel).
 */
export function invert3x3(M) {
  const [a, b, c] = M[0];
  const [d, e, f] = M[1];
  const [g, h, i] = M[2];
  const det =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) {
    throw new Error("Matriz no invertible.");
  }
  const inv = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  return inv;
}

// Convención de esquinas de CLARA (orden estricto):
//   0: cercana_izq   1: cercana_der   2: lejana_der   3: lejana_izq
export const CORNER_NAMES = [
  "cercana_izq",
  "cercana_der",
  "lejana_der",
  "lejana_izq",
];

export const CORNER_LABELS = [
  "Cercana izquierda",
  "Cercana derecha",
  "Lejana derecha",
  "Lejana izquierda",
];

/**
 * Construye el objeto cal.json que consume CLARA.
 * Replica exactamente el formato de src/setup_calibration.py.
 *
 * @param {Object} opts
 * @param {Array<[number,number]>} opts.corners - 4 esquinas en píxeles
 * @param {[number,number]} opts.frameShape - [alto, ancho] del frame
 * @param {boolean} opts.halfCourt
 * @param {string} opts.videoReference
 * @param {number} opts.ppm - pixels per meter (default 40)
 */
export function buildCalibration({
  corners,
  frameShape,
  halfCourt = false,
  videoReference = "video.mp4",
  ppm = 40,
}) {
  const courtW = 9;
  const courtH = halfCourt ? 9 : 18;
  const cw = courtW * ppm;
  const ch = courtH * ppm;

  // Mapeo destino — idéntico a setup_calibration.py
  const dst = halfCourt
    ? [
        [0, 0],
        [cw, 0],
        [cw, ch],
        [0, ch],
      ]
    : [
        [cw, 0],
        [cw, ch],
        [0, ch],
        [0, 0],
      ];

  const H = computeHomography(corners, dst);

  return {
    _comment:
      "Generado con MIRA — calibrador de CLARA. Verificado visualmente antes de exportar.",
    video_reference: videoReference,
    frame_shape: frameShape,
    court_size_m: [courtW, courtH],
    pixels_per_meter: ppm,
    pixel_corners: corners.map(([x, y]) => [Math.round(x), Math.round(y)]),
    homography_matrix: H,
    half_court: halfCourt,
    court_horizon_y: null,
    max_person_height_ratio: 0.55,
    max_person_width_ratio: 0.4,
  };
}

/**
 * Genera las líneas de la cancha (en coords de cancha, metros·ppm) para
 * dibujarlas de vuelta sobre el frame como verificación visual.
 * Devuelve segmentos [[x1,y1],[x2,y2]] en coordenadas de cancha.
 */
export function courtLines(halfCourt = false, ppm = 40) {
  const courtW = 9 * ppm;
  const courtH = (halfCourt ? 9 : 18) * ppm;
  const lines = [];
  // Perímetro
  lines.push([[0, 0], [courtW, 0]]);
  lines.push([[courtW, 0], [courtW, courtH]]);
  lines.push([[courtW, courtH], [0, courtH]]);
  lines.push([[0, courtH], [0, 0]]);

  if (halfCourt) {
    // Línea de ataque a 3 m de la red (la red es el borde y=0)
    const atk = 3 * ppm;
    lines.push([[0, atk], [courtW, atk]]);
  } else {
    // Red al centro
    const net = courtH / 2;
    lines.push([[0, net], [courtW, net]]);
    // Líneas de ataque a 3 m de la red, ambos lados
    lines.push([[0, net - 3 * ppm], [courtW, net - 3 * ppm]]);
    lines.push([[0, net + 3 * ppm], [courtW, net + 3 * ppm]]);
  }
  return lines;
}
