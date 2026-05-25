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

// Producto de dos matrices 3x3.
function mat3mul(A, B) {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
  }
  return C;
}

// Normalización de Hartley: centra los puntos en el origen y los escala para
// que la distancia media al centroide sea √2. Devuelve los puntos
// transformados y la matriz T que aplica esa transformación (x' = T·x).
// Imprescindible para que el DLT por mínimos cuadrados sea numéricamente
// estable con N puntos.
function normalizePoints(pts) {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= n;
  cy /= n;
  let dsum = 0;
  for (const [x, y] of pts) dsum += Math.hypot(x - cx, y - cy);
  const meanDist = dsum / n;
  const scale = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1;
  const T = [
    [scale, 0, -scale * cx],
    [0, scale, -scale * cy],
    [0, 0, 1],
  ];
  const out = pts.map(([x, y]) => [scale * (x - cx), scale * (y - cy)]);
  return { pts: out, T };
}

/**
 * Homografía por mínimos cuadrados a partir de N≥4 correspondencias.
 * Equivalente a cv2.findHomography (método por defecto, sin RANSAC) para el
 * caso sin outliers: DLT normalizado resuelto con ecuaciones normales.
 * @param {Array<[number,number]>} src
 * @param {Array<[number,number]>} dst
 * @returns {number[][]} matriz 3x3 con H[2][2] = 1
 */
export function findHomography(src, dst) {
  if (src.length !== dst.length) {
    throw new Error("src y dst deben tener el mismo número de puntos.");
  }
  if (src.length < 4) {
    throw new Error("Se requieren al menos 4 puntos.");
  }
  const { pts: s, T: Ts } = normalizePoints(src);
  const { pts: d, T: Td } = normalizePoints(dst);

  // Ecuaciones normales (AᵀA·x = Aᵀb) para las 8 incógnitas h0..h7 (h8=1),
  // acumulando las 2N filas sin materializar A.
  const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  const addRow = (row, bi) => {
    for (let i = 0; i < 8; i++) {
      ATb[i] += row[i] * bi;
      for (let j = 0; j < 8; j++) ATA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k];
    const [u, v] = d[k];
    addRow([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    addRow([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solveLinear(ATA, ATb);
  const Hn = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
  // Deshacer la normalización: H = Td⁻¹ · Hn · Ts
  let H = mat3mul(mat3mul(invert3x3(Td), Hn), Ts);
  const s22 = H[2][2];
  if (Math.abs(s22) < 1e-12) {
    throw new Error("Homografía degenerada — puntos casi colineales.");
  }
  H = H.map((row) => row.map((val) => val / s22));
  return H;
}

/**
 * Resuelve la homografía eligiendo el método según la cantidad de puntos:
 * exactamente 4 → DLT exacto (como getPerspectiveTransform); 5+ → mínimos
 * cuadrados (findHomography), más robusto ante el ruido de marcado manual.
 */
export function solveHomography(src, dst) {
  if (src.length !== dst.length) {
    throw new Error("src y dst deben tener el mismo número de puntos.");
  }
  if (src.length < 4) {
    throw new Error("Se requieren al menos 4 puntos de referencia.");
  }
  return src.length === 4 ? computeHomography(src, dst) : findHomography(src, dst);
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

// ── Puntos de referencia ───────────────────────────────────
// Cada punto se describe por su posición normalizada en la cancha física:
//   s ∈ [0,1] de banda izquierda (0) a derecha (1)  → ancho 9 m
//   t ∈ [0,1] de línea cercana (0) a lejana (1)      → fondo (18 m completa / 9 m media)
// `corner` es el índice 0..3 si el punto ES una de las 4 esquinas, o null.
// Estos puntos están SIEMPRE sobre el plano de la cancha, así que su
// coordenada en el espacio-cancha sale por interpolación bilineal de las 4
// esquinas — lo que mantiene la convención exacta del cal.json original,
// incluso con el mapeo "rotado" de cancha completa.
export const REFERENCE_POINTS_FULL = [
  { id: "cercana_izq", label: "Cercana izquierda", short: "1", s: 0, t: 0, corner: 0 },
  { id: "cercana_der", label: "Cercana derecha", short: "2", s: 1, t: 0, corner: 1 },
  { id: "lejana_der", label: "Lejana derecha", short: "3", s: 1, t: 1, corner: 2 },
  { id: "lejana_izq", label: "Lejana izquierda", short: "4", s: 0, t: 1, corner: 3 },
  { id: "ataque_cerca_izq", label: "Ataque (cerca) ∩ banda izq.", short: "Aci", s: 0, t: 1 / 3, corner: null },
  { id: "ataque_cerca_der", label: "Ataque (cerca) ∩ banda der.", short: "Acd", s: 1, t: 1 / 3, corner: null },
  { id: "ataque_lejos_izq", label: "Ataque (lejos) ∩ banda izq.", short: "Ali", s: 0, t: 2 / 3, corner: null },
  { id: "ataque_lejos_der", label: "Ataque (lejos) ∩ banda der.", short: "Ald", s: 1, t: 2 / 3, corner: null },
  { id: "central_izq", label: "Central ∩ banda izq.", short: "Ci", s: 0, t: 1 / 2, corner: null },
  { id: "central_der", label: "Central ∩ banda der.", short: "Cd", s: 1, t: 1 / 2, corner: null },
  { id: "fondo_cercano_medio", label: "Medio fondo cercano", short: "Fc", s: 1 / 2, t: 0, corner: null },
  { id: "fondo_lejano_medio", label: "Medio fondo lejano", short: "Fl", s: 1 / 2, t: 1, corner: null },
];

export const REFERENCE_POINTS_HALF = [
  { id: "cercana_izq", label: "Cercana izquierda (red)", short: "1", s: 0, t: 0, corner: 0 },
  { id: "cercana_der", label: "Cercana derecha (red)", short: "2", s: 1, t: 0, corner: 1 },
  { id: "lejana_der", label: "Lejana derecha", short: "3", s: 1, t: 1, corner: 2 },
  { id: "lejana_izq", label: "Lejana izquierda", short: "4", s: 0, t: 1, corner: 3 },
  { id: "ataque_izq", label: "Ataque ∩ banda izq.", short: "Ai", s: 0, t: 1 / 3, corner: null },
  { id: "ataque_der", label: "Ataque ∩ banda der.", short: "Ad", s: 1, t: 1 / 3, corner: null },
  { id: "red_medio", label: "Medio de la red", short: "R", s: 1 / 2, t: 0, corner: null },
  { id: "fondo_lejano_medio", label: "Medio fondo lejano", short: "Fl", s: 1 / 2, t: 1, corner: null },
];

export function referencePoints(halfCourt = false) {
  return halfCourt ? REFERENCE_POINTS_HALF : REFERENCE_POINTS_FULL;
}

/**
 * Coordenadas en espacio-cancha (px) de las 4 esquinas, en el orden de
 * CORNER_NAMES. Idéntico al `dst` que usa buildCalibration.
 */
export function referenceCorners(halfCourt = false, ppm = 40) {
  const cw = 9 * ppm;
  const ch = (halfCourt ? 9 : 18) * ppm;
  return halfCourt
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
}

// Interpolación bilineal dentro del rectángulo de esquinas [NL,NR,FR,FL].
function bilerp(corners, s, t) {
  const [NL, NR, FR, FL] = corners;
  return [
    (1 - s) * (1 - t) * NL[0] + s * (1 - t) * NR[0] + s * t * FR[0] + (1 - s) * t * FL[0],
    (1 - s) * (1 - t) * NL[1] + s * (1 - t) * NR[1] + s * t * FR[1] + (1 - s) * t * FL[1],
  ];
}

/**
 * Coordenada en espacio-cancha (px) de un punto con posición normalizada (s,t).
 */
export function courtPointUV(halfCourt, ppm, s, t) {
  return bilerp(referenceCorners(halfCourt, ppm), s, t);
}

/**
 * Construye el objeto cal.json que consume CLARA.
 * Replica el formato de src/setup_calibration.py y lo extiende: acepta de 4 a
 * N puntos de referencia (no solo las 4 esquinas) para videos donde alguna
 * esquina no se ve.
 *
 * @param {Object} opts
 * @param {Array<{id:string,x:number,y:number}>} [opts.points] - puntos marcados
 *   (cada uno con el id de su punto de referencia). Vía preferida.
 * @param {Array<[number,number]>} [opts.corners] - compat: 4 esquinas en píxeles
 *   en el orden de CORNER_NAMES. Se usa si no se pasa `points`.
 * @param {[number,number]} opts.frameShape - [alto, ancho] del frame
 * @param {boolean} opts.halfCourt
 * @param {string} opts.videoReference
 * @param {number} opts.ppm - pixels per meter (default 40)
 */
export function buildCalibration({
  points,
  corners,
  frameShape,
  halfCourt = false,
  videoReference = "video.mp4",
  ppm = 40,
}) {
  const courtW = 9;
  const courtH = halfCourt ? 9 : 18;

  // Normalizar la entrada a una lista de marcas {id,x,y}.
  let marks;
  if (Array.isArray(points) && points.length) {
    marks = points;
  } else if (Array.isArray(corners) && corners.length) {
    marks = corners.map(([x, y], i) => ({ id: CORNER_NAMES[i], x, y }));
  } else {
    marks = [];
  }
  if (marks.length < 4) {
    throw new Error(
      "Se requieren al menos 4 puntos de referencia para calibrar."
    );
  }

  const byId = Object.fromEntries(referencePoints(halfCourt).map((p) => [p.id, p]));

  // Correspondencias píxel → espacio-cancha (vía interpolación bilineal).
  const src = [];
  const dst = [];
  for (const m of marks) {
    const rp = byId[m.id];
    if (!rp) throw new Error(`Punto de referencia desconocido: ${m.id}`);
    src.push([m.x, m.y]);
    dst.push(courtPointUV(halfCourt, ppm, rp.s, rp.t));
  }

  const H = solveHomography(src, dst);
  const Hinv = invert3x3(H);

  // pixel_corners: si la esquina se marcó, usa el píxel real; si no, se
  // extrapola proyectando la esquina de espacio-cancha con H⁻¹.
  const cornerUV = referenceCorners(halfCourt, ppm);
  const markById = Object.fromEntries(marks.map((m) => [m.id, m]));
  const pixel_corners = CORNER_NAMES.map((id, i) => {
    const m = markById[id];
    if (m) return [Math.round(m.x), Math.round(m.y)];
    const [px, py] = projectPoint(Hinv, cornerUV[i][0], cornerUV[i][1]);
    return [Math.round(px), Math.round(py)];
  });

  // reference_points: marcas que NO son esquina (campo aditivo; no rompe el
  // esquema actual que CLARA ya lee).
  const reference_points = marks
    .filter((m) => byId[m.id] && byId[m.id].corner === null)
    .map((m) => {
      const rp = byId[m.id];
      return {
        name: rp.id,
        label: rp.label,
        court_m: [
          Math.round(rp.s * courtW * 100) / 100,
          Math.round(rp.t * courtH * 100) / 100,
        ],
        pixel: [Math.round(m.x), Math.round(m.y)],
      };
    });

  const cal = {
    _comment:
      "Generado con MIRA — calibrador de CLARA. Verificado visualmente antes de exportar.",
    video_reference: videoReference,
    frame_shape: frameShape,
    court_size_m: [courtW, courtH],
    pixels_per_meter: ppm,
    pixel_corners,
    homography_matrix: H,
    half_court: halfCourt,
    court_horizon_y: null,
    max_person_height_ratio: 0.55,
    max_person_width_ratio: 0.4,
  };
  // Solo se agrega cuando hay puntos no-esquina, para que el caso clásico de
  // 4 esquinas produzca exactamente el mismo JSON de antes.
  if (reference_points.length) cal.reference_points = reference_points;
  return cal;
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
    // Media cancha: el espacio-cancha es natural (x=ancho, y=fondo) y la red
    // es el borde y=0. La línea de ataque va a 3 m de la red.
    const atk = 3 * ppm;
    lines.push([[0, atk], [courtW, atk]]);
  } else {
    // Cancha completa: el espacio-cancha está transpuesto respecto al físico
    // (eje x = profundidad cercana↔lejana, eje y = ancho izq↔der), igual que el
    // mapeo de esquinas del cal.json. Por eso la red y las líneas de ataque son
    // verticales (x constante) y NO horizontales — así calzan con las líneas
    // reales y con los puntos de referencia internos.
    const mid = courtW / 2; // red: centro de la profundidad
    const off = courtW / 6; // 3 m sobre los 18 m de fondo, mapeados al eje x
    lines.push([[mid, 0], [mid, courtH]]);
    lines.push([[mid - off, 0], [mid - off, courtH]]);
    lines.push([[mid + off, 0], [mid + off, courtH]]);
  }
  return lines;
}
