/**
 * @jest-environment node
 *
 * Sanity check de lib/homography.js — la matemática que CLARA consume.
 * Si esto pasa: el cal.json que genera MIRA es matemáticamente equivalente
 * a cv2.findHomography para 4 correspondencias.
 */
import {
  computeHomography,
  invert3x3,
  projectPoint,
  buildCalibration,
  courtLines,
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
});

describe("constantes", () => {
  test("CORNER_NAMES y CORNER_LABELS tienen 4 entradas alineadas", () => {
    expect(CORNER_NAMES).toHaveLength(4);
    expect(CORNER_LABELS).toHaveLength(4);
    expect(CORNER_NAMES[0]).toBe("cercana_izq");
  });
});
