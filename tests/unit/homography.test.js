/**
 * @jest-environment node
 *
 * Sanity check de lib/homography.js — la matemática que CLARA consume.
 * Si esto pasa: el cal.json que genera MIRA es matemáticamente equivalente
 * a cv2.findHomography para 4 correspondencias.
 */
import {
  computeHomography,
  findHomography,
  solveHomography,
  invert3x3,
  projectPoint,
  buildCalibration,
  courtLines,
  courtPointUV,
  referenceCorners,
  referencePoints,
  CORNER_NAMES,
  CORNER_LABELS,
} from "@/lib/homography";

const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

describe("computeHomography", () => {
  test("identidad: src == dst → H proyecta cualquier punto a sí mismo", () => {
    const pts = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const H = computeHomography(pts, pts);
    const [x, y] = projectPoint(H, 50, 50);
    expect(close(x, 50)).toBe(true);
    expect(close(y, 50)).toBe(true);
  });

  test("forward: cada src[i] proyecta exactamente a dst[i]", () => {
    const src = [
      [120, 80],
      [880, 100],
      [950, 600],
      [80, 580],
    ];
    const dst = [
      [360, 0],
      [360, 720],
      [0, 720],
      [0, 0],
    ];
    const H = computeHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      const [u, v] = projectPoint(H, src[i][0], src[i][1]);
      expect(close(u, dst[i][0], 1e-4)).toBe(true);
      expect(close(v, dst[i][1], 1e-4)).toBe(true);
    }
  });

  test("round-trip: H⁻¹(H(p)) ≈ p para puntos interiores", () => {
    const src = [
      [120, 80],
      [880, 100],
      [950, 600],
      [80, 580],
    ];
    const dst = [
      [360, 0],
      [360, 720],
      [0, 720],
      [0, 0],
    ];
    const H = computeHomography(src, dst);
    const Hi = invert3x3(H);
    for (const [x, y] of [
      [200, 200],
      [500, 300],
      [800, 500],
    ]) {
      const [u, v] = projectPoint(H, x, y);
      const [x2, y2] = projectPoint(Hi, u, v);
      expect(close(x, x2, 1e-4)).toBe(true);
      expect(close(y, y2, 1e-4)).toBe(true);
    }
  });

  test("degenerado: 4 puntos colineales tiran 'Sistema singular'", () => {
    expect(() =>
      computeHomography(
        [
          [0, 0],
          [10, 10],
          [20, 20],
          [30, 30],
        ],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]
      )
    ).toThrow(/singular/i);
  });

  test("validación: src o dst con !=4 puntos tira", () => {
    expect(() => computeHomography([[0, 0]], [[0, 0]])).toThrow(/4 puntos/);
  });
});

describe("findHomography (N puntos, mínimos cuadrados)", () => {
  // Homografía "verdadera" arbitraria para generar correspondencias exactas.
  const Htrue = computeHomography(
    [
      [120, 80],
      [880, 100],
      [950, 600],
      [80, 580],
    ],
    [
      [360, 0],
      [360, 720],
      [0, 720],
      [0, 0],
    ]
  );
  const srcPts = [
    [120, 80],
    [880, 100],
    [950, 600],
    [80, 580],
    [500, 90],
    [510, 600],
    [300, 300],
  ];
  const dstPts = srcPts.map(([x, y]) => projectPoint(Htrue, x, y));

  test("recupera la homografía con 6+ puntos sin ruido (error ~0)", () => {
    const H = findHomography(srcPts, dstPts);
    for (let i = 0; i < srcPts.length; i++) {
      const [u, v] = projectPoint(H, srcPts[i][0], srcPts[i][1]);
      expect(close(u, dstPts[i][0], 1e-4)).toBe(true);
      expect(close(v, dstPts[i][1], 1e-4)).toBe(true);
    }
  });

  test("absorbe ruido leve: el ajuste sigue cerca de los destinos", () => {
    const noisy = srcPts.map(([x, y]) => [x + (x % 3) - 1, y + (y % 3) - 1]);
    const H = findHomography(noisy, dstPts);
    let maxErr = 0;
    for (let i = 0; i < noisy.length; i++) {
      const [u, v] = projectPoint(H, noisy[i][0], noisy[i][1]);
      maxErr = Math.max(maxErr, Math.hypot(u - dstPts[i][0], v - dstPts[i][1]));
    }
    // Con ruido sub-píxel en src el residuo en espacio-cancha queda acotado.
    expect(maxErr).toBeLessThan(20);
  });

  test("H[2][2] queda normalizado a 1", () => {
    const H = findHomography(srcPts, dstPts);
    expect(close(H[2][2], 1)).toBe(true);
  });

  test("menos de 4 puntos tira", () => {
    expect(() => findHomography([[0, 0]], [[0, 0]])).toThrow(/al menos 4/i);
  });
});

describe("solveHomography (elige exacto vs mínimos cuadrados)", () => {
  const src4 = [
    [120, 80],
    [880, 100],
    [950, 600],
    [80, 580],
  ];
  const dst4 = [
    [360, 0],
    [360, 720],
    [0, 720],
    [0, 0],
  ];

  test("con 4 puntos coincide con computeHomography (DLT exacto)", () => {
    const a = solveHomography(src4, dst4);
    const b = computeHomography(src4, dst4);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(close(a[i][j], b[i][j], 1e-9)).toBe(true);
  });

  test("con 5+ puntos resuelve por mínimos cuadrados y mapea bien", () => {
    const Htrue = computeHomography(src4, dst4);
    const src = [...src4, [500, 300]];
    const dst = src.map(([x, y]) => projectPoint(Htrue, x, y));
    const H = solveHomography(src, dst);
    const [u, v] = projectPoint(H, 500, 300);
    expect(close(u, dst[4][0], 1e-3)).toBe(true);
    expect(close(v, dst[4][1], 1e-3)).toBe(true);
  });

  test("menos de 4 puntos tira", () => {
    expect(() => solveHomography([[0, 0]], [[0, 0]])).toThrow(/al menos 4/i);
  });
});

describe("courtPointUV (interpolación de puntos de referencia)", () => {
  test("las 4 esquinas reproducen referenceCorners", () => {
    const C = referenceCorners(false, 40);
    const rp = referencePoints(false);
    for (const p of rp.filter((p) => p.corner !== null)) {
      const uv = courtPointUV(false, 40, p.s, p.t);
      expect(close(uv[0], C[p.corner][0])).toBe(true);
      expect(close(uv[1], C[p.corner][1])).toBe(true);
    }
  });

  test("medio fondo cercano cae en el punto medio de la línea cercana", () => {
    // cercana_izq=(360,0), cercana_der=(360,720) → medio = (360,360)
    const uv = courtPointUV(false, 40, 0.5, 0);
    expect(close(uv[0], 360)).toBe(true);
    expect(close(uv[1], 360)).toBe(true);
  });
});

describe("buildCalibration con puntos flexibles", () => {
  test("acepta puntos no-esquina y los guarda en reference_points", () => {
    const cal = buildCalibration({
      points: [
        { id: "cercana_izq", x: 100, y: 50 },
        { id: "cercana_der", x: 900, y: 60 },
        { id: "lejana_der", x: 950, y: 700 },
        { id: "ataque_cerca_izq", x: 120, y: 300 },
        { id: "central_der", x: 930, y: 380 },
      ],
      frameShape: [720, 1280],
      halfCourt: false,
      ppm: 40,
    });
    expect(cal.pixel_corners).toHaveLength(4);
    expect(cal.homography_matrix).toHaveLength(3);
    expect(Array.isArray(cal.reference_points)).toBe(true);
    expect(cal.reference_points).toHaveLength(2);
    const names = cal.reference_points.map((r) => r.name);
    expect(names).toContain("ataque_cerca_izq");
    expect(names).toContain("central_der");
    cal.pixel_corners.forEach(([x, y]) => {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    });
  });

  test("extrapola una esquina no marcada vía H⁻¹", () => {
    // No se marca lejana_izq; se usan 4 puntos (3 esquinas + 1 interno).
    const cal = buildCalibration({
      points: [
        { id: "cercana_izq", x: 100, y: 50 },
        { id: "cercana_der", x: 900, y: 60 },
        { id: "lejana_der", x: 950, y: 700 },
        { id: "fondo_lejano_medio", x: 500, y: 690 },
      ],
      frameShape: [720, 1280],
      ppm: 40,
    });
    expect(cal.pixel_corners).toHaveLength(4);
    // La esquina extrapolada (índice 3, lejana_izq) debe ser entero finito.
    const [lx, ly] = cal.pixel_corners[3];
    expect(Number.isInteger(lx)).toBe(true);
    expect(Number.isInteger(ly)).toBe(true);
    expect(Number.isFinite(lx)).toBe(true);
  });

  test("menos de 4 puntos tira y no exporta", () => {
    expect(() =>
      buildCalibration({
        points: [
          { id: "cercana_izq", x: 1, y: 1 },
          { id: "cercana_der", x: 2, y: 2 },
          { id: "lejana_der", x: 3, y: 1 },
        ],
        frameShape: [720, 1280],
      })
    ).toThrow(/al menos 4/i);
  });

  test("el camino clásico de 4 esquinas no agrega reference_points", () => {
    const cal = buildCalibration({
      corners: [
        [100, 50],
        [900, 60],
        [950, 700],
        [50, 690],
      ],
      frameShape: [720, 1280],
      ppm: 40,
    });
    expect(cal.reference_points).toBeUndefined();
  });
});

describe("invert3x3", () => {
  test("M · M⁻¹ ≈ I", () => {
    const M = [
      [2, 0, 1],
      [1, 3, 0],
      [0, 1, 2],
    ];
    const Mi = invert3x3(M);
    // Producto M·Mi (filas de M, columnas de Mi)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const v = M[i][0] * Mi[0][j] + M[i][1] * Mi[1][j] + M[i][2] * Mi[2][j];
        expect(close(v, i === j ? 1 : 0)).toBe(true);
      }
    }
  });

  test("matriz singular tira", () => {
    expect(() =>
      invert3x3([
        [1, 2, 3],
        [2, 4, 6],
        [3, 6, 9],
      ])
    ).toThrow(/invertible/i);
  });
});

describe("buildCalibration", () => {
  test("produce el shape que CLARA espera (full-court)", () => {
    const cal = buildCalibration({
      corners: [
        [100, 50],
        [900, 60],
        [950, 700],
        [50, 690],
      ],
      frameShape: [720, 1280],
      halfCourt: false,
      videoReference: "test.mp4",
      ppm: 40,
    });
    expect(cal.video_reference).toBe("test.mp4");
    expect(cal.half_court).toBe(false);
    expect(cal.frame_shape).toEqual([720, 1280]);
    expect(cal.pixels_per_meter).toBe(40);
    expect(cal.court_size_m).toEqual([9, 18]);
    expect(cal.pixel_corners).toHaveLength(4);
    expect(cal.homography_matrix).toHaveLength(3);
    expect(cal.homography_matrix[0]).toHaveLength(3);
    // h[2][2] debe ser 1 por construcción (DLT con h8 fijo)
    expect(close(cal.homography_matrix[2][2], 1)).toBe(true);
    // pixel_corners debe estar redondeado a enteros
    cal.pixel_corners.forEach(([x, y]) => {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    });
  });

  test("half-court usa court_size_m [9, 9]", () => {
    const cal = buildCalibration({
      corners: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      frameShape: [200, 200],
      halfCourt: true,
    });
    expect(cal.half_court).toBe(true);
    expect(cal.court_size_m).toEqual([9, 9]);
  });
});

describe("courtLines", () => {
  test("full-court tiene perímetro + red + 2 líneas de ataque (7 segmentos)", () => {
    expect(courtLines(false, 40)).toHaveLength(7);
  });

  test("half-court tiene perímetro + 1 línea de ataque (5 segmentos)", () => {
    expect(courtLines(true, 40)).toHaveLength(5);
  });

  test("full-court: la red coincide con los puntos centrales de referencia", () => {
    // courtLines[4] es la red. Sus extremos deben caer sobre central_izq y
    // central_der (la red ∩ cada banda) — así el overlay calza con los puntos.
    const net = courtLines(false, 40)[4];
    const ci = courtPointUV(false, 40, 0, 0.5);
    const cd = courtPointUV(false, 40, 1, 0.5);
    const ends = [net[0], net[1]];
    // Sin asumir orden: ambos extremos están entre {central_izq, central_der}.
    const eq = (a, b) => close(a[0], b[0]) && close(a[1], b[1]);
    expect(ends.some((e) => eq(e, ci))).toBe(true);
    expect(ends.some((e) => eq(e, cd))).toBe(true);
  });

  test("full-court: las líneas de ataque caen en x = 6·ppm y 3·ppm", () => {
    // Ataque a 3 m de la red sobre el eje de profundidad (transpuesto a x).
    const xs = courtLines(false, 40)
      .slice(5, 7)
      .map((seg) => seg[0][0])
      .sort((a, b) => a - b);
    expect(xs).toEqual([120, 240]); // 3·ppm y 6·ppm con ppm=40
  });
});

describe("constantes", () => {
  test("CORNER_NAMES y CORNER_LABELS tienen 4 entradas alineadas", () => {
    expect(CORNER_NAMES).toHaveLength(4);
    expect(CORNER_LABELS).toHaveLength(4);
    expect(CORNER_NAMES[0]).toBe("cercana_izq");
  });
});
