"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  buildCalibration,
  computeHomography,
  invert3x3,
  projectPoint,
  courtLines,
  CORNER_LABELS,
} from "@/lib/homography";

// Radio de captura para arrastrar una esquina (en px naturales de imagen)
const GRAB_RADIUS = 26;
// Lupa: tamaño chico y fijo en una esquina; el zoom es ajustable en runtime.
const LOUPE_SIZE = 128;
const LOUPE_MIN_ZOOM = 2;
const LOUPE_MAX_ZOOM = 16;
const LOUPE_DEFAULT_ZOOM = 6;
const clampZoom = (z) =>
  Math.max(LOUPE_MIN_ZOOM, Math.min(LOUPE_MAX_ZOOM, Math.round(z)));

export default function Calibrator({
  embedded = false,
  initialFrame = null,
  onFrameConsumed,
}) {
  const canvasRef = useRef(null);
  const loupeRef = useRef(null);
  const imgRef = useRef(null);
  const fileInputRef = useRef(null);
  const objectUrlRef = useRef(null);
  const lastInitialFrameRef = useRef(null);

  const [imageName, setImageName] = useState("");
  const [imageLoaded, setImageLoaded] = useState(false);
  const [corners, setCorners] = useState([]); // {x,y} en coords naturales
  const [dragIndex, setDragIndex] = useState(-1);
  // Esquina "enfocada" para ajuste fino con flechas (independiente del drag).
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loupeZoom, setLoupeZoom] = useState(LOUPE_DEFAULT_ZOOM);
  const [halfCourt, setHalfCourt] = useState(false);
  const [ppm, setPpm] = useState(40);
  const [videoRef, setVideoRef] = useState("video.mp4");
  const [cursor, setCursor] = useState(null); // {x,y,clientX,clientY}
  const [naturalSize, setNaturalSize] = useState([0, 0]);
  const [loadError, setLoadError] = useState("");

  // Flag para evitar setState si la imagen termina de decodificar después
  // del unmount (típico al cambiar de pestaña mientras carga).
  const mountedRef = useRef(true);

  // ── Carga de imagen ──────────────────────────────────────
  const loadFile = useCallback((file) => {
    if (!file) {
      setLoadError("No se eligió archivo.");
      return;
    }
    // Algunos navegadores/SO no rellenan file.type para PNG re-descargados
    // (OneDrive, share targets, etc.). Aceptamos también por extensión —
    // si el contenido no es imagen, img.onerror lo cazará abajo.
    const isImageByType = file.type?.startsWith("image/");
    const isImageByExt = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(
      file.name || ""
    );
    if (!isImageByType && !isImageByExt) {
      setLoadError("El archivo no es una imagen válida.");
      return;
    }
    setLoadError("");
    // Liberar URL anterior antes de crear la nueva
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    const img = new Image();
    img.onload = () => {
      if (!mountedRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      imgRef.current = img;
      setNaturalSize([img.naturalWidth, img.naturalHeight]);
      setImageLoaded(true);
      setCorners([]);
      setDragIndex(-1);
      setSelectedIndex(-1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (objectUrlRef.current === url) objectUrlRef.current = null;
      if (!mountedRef.current) return;
      // Si el archivo es chico (< 2MB), avisar que probablemente fue
      // extraído cuando el video estaba en negro. Para 720p+ con contenido
      // real una imagen suele pesar más que eso.
      const fmtSize = (n) =>
        n >= 1_000_000
          ? (n / 1_000_000).toFixed(2) + " MB"
          : (n / 1000).toFixed(1) + " KB";
      setLoadError(
        "No se pudo decodificar la imagen. " +
          (file.size < 2_000_000
            ? "El archivo pesa " +
              fmtSize(file.size) +
              " — probablemente fue extraído cuando el video estaba en negro. Re-extraé el frame desde Video/Frames."
            : "El archivo podría estar corrupto.")
      );
    };
    img.src = url;
    setImageName(file.name);
    // Sugerir nombre de video a partir del frame
    const base = file.name.replace(/\.(png|jpe?g|webp)$/i, "");
    setVideoRef(base + ".mp4");
  }, []);

  // Liberar la URL del blob al desmontar el componente
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // Si el padre nos pasa un frame (por ejemplo extraído de un video), cargarlo
  // automáticamente. Se compara por identidad del File para no recargar en cada
  // render — solo cuando llega un objeto nuevo.
  useEffect(() => {
    if (!initialFrame) return;
    if (lastInitialFrameRef.current === initialFrame) return;
    lastInitialFrameRef.current = initialFrame;
    loadFile(initialFrame);
    onFrameConsumed?.();
  }, [initialFrame, loadFile, onFrameConsumed]);

  const onDrop = (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  };

  // ── Conversión coords pantalla → coords naturales ────────
  const toNatural = (clientX, clientY) => {
    const cv = canvasRef.current;
    const rect = cv.getBoundingClientRect();
    const sx = cv.width / rect.width;
    const sy = cv.height / rect.height;
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    };
  };

  // ── Eventos de mouse sobre el canvas ─────────────────────
  const onCanvasDown = (e) => {
    if (!imageLoaded) return;
    const p = toNatural(e.clientX, e.clientY);
    // ¿Tocó una esquina existente? → arrastrar (y enfocarla para las flechas)
    for (let i = 0; i < corners.length; i++) {
      const dx = corners[i].x - p.x;
      const dy = corners[i].y - p.y;
      if (Math.hypot(dx, dy) < GRAB_RADIUS) {
        setDragIndex(i);
        setSelectedIndex(i);
        return;
      }
    }
    // Si faltan esquinas, colocar la siguiente y dejarla enfocada
    if (corners.length < 4) {
      setSelectedIndex(corners.length);
      setCorners([...corners, { x: p.x, y: p.y }]);
    }
  };

  const onCanvasMove = (e) => {
    if (!imageLoaded) return;
    const cv = canvasRef.current;
    const rect = cv.getBoundingClientRect();
    const p = {
      x: ((e.clientX - rect.left) * cv.width) / rect.width,
      y: ((e.clientY - rect.top) * cv.height) / rect.height,
    };
    // Fracción 0..1 dentro del lienzo: ubica la lupa en la esquina opuesta
    // al cursor para que no tape el punto que estás marcando.
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    setCursor({ x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY, fx, fy });
    // Guard de bounds: si las esquinas se resetearon mientras arrastrábamos
    // (por ejemplo al cargar un frame nuevo desde el extractor de video),
    // dragIndex puede haber quedado apuntando fuera del array. Sin esto
    // generaba esquinas fantasma con índices sparse.
    if (dragIndex >= 0 && dragIndex < corners.length) {
      const next = [...corners];
      next[dragIndex] = {
        x: Math.max(0, Math.min(naturalSize[0], p.x)),
        y: Math.max(0, Math.min(naturalSize[1], p.y)),
      };
      setCorners(next);
    }
  };

  const onCanvasUp = () => setDragIndex(-1);
  const onCanvasLeave = () => {
    // Solo escondemos la lupa: el drag sigue vivo mientras el botón esté
    // presionado — un mouseup global lo termina (ver useEffect más abajo).
    setCursor(null);
  };

  // Mouseup global: termina cualquier drag aunque el usuario suelte el botón
  // fuera del canvas.
  useEffect(() => {
    if (dragIndex < 0) return;
    const up = () => setDragIndex(-1);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragIndex]);

  // Teclado: flechas mueven la esquina enfocada 1 px (Shift = 10 px) para
  // ajuste fino sin pelear con el mouse; + / − ajustan el zoom de la lupa.
  useEffect(() => {
    if (!imageLoaded) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setLoupeZoom((z) => clampZoom(z + 1));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setLoupeZoom((z) => clampZoom(z - 1));
        return;
      }
      if (selectedIndex < 0) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      setCorners((prev) => {
        if (selectedIndex >= prev.length) return prev;
        const next = [...prev];
        const c = next[selectedIndex];
        next[selectedIndex] = {
          x: Math.max(0, Math.min(naturalSize[0], c.x + dx)),
          y: Math.max(0, Math.min(naturalSize[1], c.y + dy)),
        };
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imageLoaded, selectedIndex, naturalSize]);

  // Rueda del mouse sobre el lienzo: acerca/aleja la lupa. Listener nativo
  // no-pasivo para poder cancelar el scroll de la página.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !imageLoaded) return;
    const onWheel = (e) => {
      e.preventDefault();
      setLoupeZoom((z) => clampZoom(z + (e.deltaY < 0 ? 1 : -1)));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [imageLoaded]);

  // ── Render del canvas principal ──────────────────────────
  useEffect(() => {
    if (!imageLoaded) return;
    const cv = canvasRef.current;
    const img = imgRef.current;
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const S = img.naturalWidth / 1000; // escala de trazos según resolución

    // Verificación: cancha proyectada de vuelta sobre el frame
    if (corners.length === 4) {
      try {
        const courtW = 9 * ppm;
        const courtH = (halfCourt ? 9 : 18) * ppm;
        const dst = halfCourt
          ? [
              [0, 0],
              [courtW, 0],
              [courtW, courtH],
              [0, courtH],
            ]
          : [
              [courtW, 0],
              [courtW, courtH],
              [0, courtH],
              [0, 0],
            ];
        const H = computeHomography(
          corners.map((c) => [c.x, c.y]),
          dst
        );
        const Hinv = invert3x3(H);
        const lines = courtLines(halfCourt, ppm);
        ctx.strokeStyle = "#5fd0d8";
        ctx.lineWidth = 2.5 * S;
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 3 * S;
        lines.forEach(([a, b]) => {
          const [ax, ay] = projectPoint(Hinv, a[0], a[1]);
          const [bx, by] = projectPoint(Hinv, b[0], b[1]);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        });
        ctx.shadowBlur = 0;
      } catch {
        /* cuadrilátero inválido — se ignora */
      }
    }

    // Cuadrilátero entre las esquinas marcadas
    if (corners.length > 1) {
      ctx.strokeStyle = "rgba(184,122,106,0.55)";
      ctx.lineWidth = 1.5 * S;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) {
        ctx.lineTo(corners[i].x, corners[i].y);
      }
      if (corners.length === 4) ctx.closePath();
      ctx.stroke();
    }

    // Esquinas
    corners.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 7 * S, 0, Math.PI * 2);
      ctx.fillStyle = "#b87a6a";
      ctx.fill();
      ctx.lineWidth = 2 * S;
      ctx.strokeStyle = "#0a0a0a";
      ctx.stroke();
      // Etiqueta
      ctx.font = `${13 * S}px ui-monospace, monospace`;
      ctx.fillStyle = "#ebe9e3";
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 3 * S;
      const label = String(i + 1);
      ctx.strokeText(label, c.x + 11 * S, c.y - 9 * S);
      ctx.fillText(label, c.x + 11 * S, c.y - 9 * S);
    });

    // Anillo punteado sobre la esquina enfocada: indica cuál mueven las flechas.
    if (selectedIndex >= 0 && selectedIndex < corners.length) {
      const sc = corners[selectedIndex];
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 13 * S, 0, Math.PI * 2);
      ctx.setLineDash([4 * S, 3 * S]);
      ctx.lineWidth = 2 * S;
      ctx.strokeStyle = "#5fd0d8";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [imageLoaded, corners, halfCourt, ppm, selectedIndex]);

  // ── Render de la lupa ────────────────────────────────────
  // Nota: durante el arrastre mantenemos la lupa visible — sigue siendo útil
  // para ver al detalle hacia dónde arrastras la esquina.
  useEffect(() => {
    const lp = loupeRef.current;
    if (!lp) return;
    const ctx = lp.getContext("2d");
    ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    if (!cursor || !imageLoaded) return;
    const img = imgRef.current;
    const src = LOUPE_SIZE / loupeZoom;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      cursor.x - src / 2,
      cursor.y - src / 2,
      src,
      src,
      0,
      0,
      LOUPE_SIZE,
      LOUPE_SIZE
    );

    const c = LOUPE_SIZE / 2;

    // Recuadro del píxel exacto bajo la mira (el que se guardará al hacer clic),
    // alineado a la grilla real de píxeles de la imagen.
    const fracX = cursor.x - Math.floor(cursor.x);
    const fracY = cursor.y - Math.floor(cursor.y);
    ctx.strokeStyle = "rgba(95,208,216,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(c - fracX * loupeZoom) + 0.5,
      Math.round(c - fracY * loupeZoom) + 0.5,
      loupeZoom,
      loupeZoom
    );

    // Cruz fina con un hueco central para no tapar el píxel objetivo.
    const gap = Math.max(loupeZoom, 7);
    const drawCross = (color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(c, 0);
      ctx.lineTo(c, c - gap);
      ctx.moveTo(c, c + gap);
      ctx.lineTo(c, LOUPE_SIZE);
      ctx.moveTo(0, c);
      ctx.lineTo(c - gap, c);
      ctx.moveTo(c + gap, c);
      ctx.lineTo(LOUPE_SIZE, c);
      ctx.stroke();
    };
    drawCross("rgba(0,0,0,0.85)", 2.5); // contorno oscuro para contraste
    drawCross("#5fd0d8", 1); // núcleo cian

    // Punto central: marca el píxel exacto que vas a marcar.
    ctx.beginPath();
    ctx.arc(c, c, 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.stroke();
  }, [cursor, imageLoaded, loupeZoom]);

  // ── Exportar cal.json ────────────────────────────────────
  const exportJson = () => {
    if (corners.length !== 4) return;
    let cal;
    try {
      cal = buildCalibration({
        corners: corners.map((c) => [c.x, c.y]),
        frameShape: [naturalSize[1], naturalSize[0]],
        halfCourt,
        videoReference: videoRef,
        ppm,
      });
    } catch (err) {
      // Esquinas degeneradas (colineales o coincidentes) → homografía inválida
      alert(
        "No se pudo calcular la homografía: " +
          (err?.message || "esquinas inválidas") +
          ".\nAjusta las esquinas y vuelve a intentar."
      );
      return;
    }
    const blob = new Blob([JSON.stringify(cal, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cal.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setCorners([]);
    setDragIndex(-1);
    setSelectedIndex(-1);
  };

  const ready = corners.length === 4;
  const nextCorner = corners.length < 4 ? corners.length : -1;

  // Micro-guía de orden: qué esquina toca ahora (o cuál estás ajustando), para
  // no cruzar el orden al calibrar.
  let guideText;
  if (dragIndex >= 0 && corners[dragIndex]) {
    guideText = `Ajustando esquina ${dragIndex + 1}: ${CORNER_LABELS[dragIndex]}`;
  } else if (nextCorner >= 0) {
    guideText = `Marca esquina ${nextCorner + 1}: ${CORNER_LABELS[nextCorner]}`;
  } else if (selectedIndex >= 0 && corners[selectedIndex]) {
    guideText = `Esquina ${selectedIndex + 1}: ${CORNER_LABELS[selectedIndex]} · flechas = 1 px`;
  } else {
    guideText = "4 esquinas listas — clic en una para ajustar";
  }

  return (
    <div className={"wrap" + (embedded ? " embedded" : "")}>
      {!embedded && (
        <header className="header">
          <div className="brand">
            <span className="brand-mark">MIRA</span>
            <span className="brand-sep">/</span>
            <span className="brand-sub">Calibrador de cancha · CLARA</span>
          </div>
          <span className="brand-ver">v0.1 — Fase 1</span>
        </header>
      )}

      <div className="layout">
        {/* ── Lienzo ── */}
        <main className="stage">
          {/* Banner de error visible siempre (afuera del dropzone, que
              con aspect-ratio:16/9 lo recortaba si el texto era largo). */}
          {loadError && (
            <div className="cal-error" role="alert">
              <strong>Error:</strong> {loadError}
              <button
                className="cal-error-close"
                onClick={() => setLoadError("")}
                aria-label="Cerrar mensaje"
              >
                ×
              </button>
            </div>
          )}
          {!imageLoaded ? (
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="dz-inner">
                <div className="dz-icon">[ + ]</div>
                <div className="dz-title">Carga un frame del video</div>
                <div className="dz-hint">
                  Arrastra una imagen aquí, o haz clic para elegir.
                  <br />
                  Extrae el frame con el Frame Extractor o cualquier captura.
                </div>
              </div>
            </div>
          ) : (
            <div className="canvas-host">
              <canvas
                ref={canvasRef}
                className="court-canvas"
                onMouseDown={onCanvasDown}
                onMouseMove={onCanvasMove}
                onMouseUp={onCanvasUp}
                onMouseLeave={onCanvasLeave}
              />
              {/* Micro-guía de orden, fija arriba: siempre visible al calibrar */}
              <div className="guide-pill">{guideText}</div>
              {cursor && (
                <div
                  className="loupe"
                  style={{
                    // Esquina fija del lienzo, opuesta al cursor → no tapa el
                    // punto que estás marcando.
                    ...(cursor.fx < 0.5 ? { right: 12 } : { left: 12 }),
                    ...(cursor.fy < 0.5 ? { bottom: 12 } : { top: 12 }),
                  }}
                >
                  <div className="loupe-lens">
                    <canvas
                      ref={loupeRef}
                      width={LOUPE_SIZE}
                      height={LOUPE_SIZE}
                    />
                  </div>
                  <div className="loupe-cap">{loupeZoom}×</div>
                </div>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            // Extensiones explícitas además de "image/*": PNG re-descargados
            // (OneDrive, share targets) llegan con file.type vacío y serían
            // ocultados del picker con solo "image/*".
            accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif"
            style={{ display: "none" }}
            onChange={(e) => loadFile(e.target.files[0])}
          />
        </main>

        {/* ── Panel ── */}
        <aside className="panel">
          <Section title="Frame">
            {imageLoaded ? (
              <div className="kv">
                <span className="k">archivo</span>
                <span className="v">{imageName}</span>
                <span className="k">resolución</span>
                <span className="v">
                  {naturalSize[0]} × {naturalSize[1]}
                </span>
              </div>
            ) : (
              <p className="muted">Ningún frame cargado.</p>
            )}
            {imageLoaded && (
              <button
                className="btn ghost"
                onClick={() => fileInputRef.current?.click()}
              >
                Cambiar frame
              </button>
            )}
          </Section>

          <Section title="Esquinas de la cancha">
            <p className="muted">
              Marca las 4 esquinas en orden. Usa la lupa para clavar el punto.
              Después selecciona una (clic en el punto o en la lista) y ajústala
              con las flechas: 1 px, o 10 px con Shift.
            </p>
            <ol className="corners">
              {CORNER_LABELS.map((label, i) => {
                const c = corners[i];
                const isNext = i === nextCorner;
                const isSel = i === selectedIndex && !!c;
                return (
                  <li
                    key={i}
                    className={
                      "corner-row" +
                      (c ? " done" : "") +
                      (isNext ? " next" : "") +
                      (isSel ? " sel" : "")
                    }
                    onClick={() => c && setSelectedIndex(i)}
                  >
                    <span className="corner-num">{i + 1}</span>
                    <span className="corner-label">{label}</span>
                    <span className="corner-coord">
                      {c
                        ? `${Math.round(c.x)}, ${Math.round(c.y)}`
                        : isNext
                        ? "← marca esta"
                        : "—"}
                    </span>
                  </li>
                );
              })}
            </ol>
            {corners.length > 0 && (
              <button className="btn ghost" onClick={reset}>
                Reiniciar esquinas
              </button>
            )}
          </Section>

          <Section title="Lupa">
            <div className="zoom-ctl">
              <button
                className="zoom-btn"
                onClick={() => setLoupeZoom((z) => clampZoom(z - 1))}
                disabled={loupeZoom <= LOUPE_MIN_ZOOM}
                aria-label="Alejar lupa"
              >
                −
              </button>
              <span className="zoom-val">{loupeZoom}×</span>
              <button
                className="zoom-btn"
                onClick={() => setLoupeZoom((z) => clampZoom(z + 1))}
                disabled={loupeZoom >= LOUPE_MAX_ZOOM}
                aria-label="Acercar lupa"
              >
                +
              </button>
            </div>
            <p className="muted tiny">
              También con la rueda del mouse sobre el frame, o las teclas +
              / −. La cruz con punto central marca el píxel exacto.
            </p>
          </Section>

          <Section title="Tipo de cancha">
            <div className="seg">
              <button
                className={!halfCourt ? "seg-on" : ""}
                onClick={() => setHalfCourt(false)}
              >
                Completa 9×18
              </button>
              <button
                className={halfCourt ? "seg-on" : ""}
                onClick={() => setHalfCourt(true)}
              >
                Media 9×9
              </button>
            </div>
          </Section>

          <Section title="Avanzado">
            <div className="field">
              <label>Píxeles por metro</label>
              <input
                type="number"
                value={ppm}
                min={10}
                max={120}
                onChange={(e) => {
                  // Clamp manual: el min/max del HTML sólo afecta al spinner;
                  // tecleando se puede meter 1 o 9999 y romper la escala del
                  // dibujo de verificación.
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n) || n <= 0) {
                    setPpm(40);
                  } else {
                    setPpm(Math.min(120, Math.max(10, n)));
                  }
                }}
              />
            </div>
            <div className="field">
              <label>Referencia de video</label>
              <input
                type="text"
                value={videoRef}
                onChange={(e) => setVideoRef(e.target.value)}
              />
            </div>
          </Section>

          {/* Verificación + export */}
          <div className="verify">
            {ready ? (
              <p className="verify-ok">
                ✓ Cancha proyectada en cian. Verifica que calce con las líneas
                reales antes de exportar — si no, arrastra las esquinas.
              </p>
            ) : (
              <p className="verify-wait">
                Faltan {4 - corners.length} esquina
                {4 - corners.length === 1 ? "" : "s"}.
              </p>
            )}
            <button
              className="btn primary"
              disabled={!ready}
              onClick={exportJson}
            >
              Exportar cal.json
            </button>
            <p className="muted tiny">
              El archivo se descarga listo para{" "}
              <code>python src/clara.py --calibration cal.json</code>
            </p>
          </div>
        </aside>
      </div>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .wrap.embedded {
          min-height: 0;
          flex: 1;
        }
        .wrap.embedded .court-canvas {
          max-height: calc(100vh - 200px);
        }
        .header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 18px 24px;
          border-bottom: 1px solid var(--border);
        }
        .brand {
          display: flex;
          align-items: baseline;
          gap: 10px;
        }
        .brand-mark {
          font-family: var(--mono);
          font-size: 18px;
          font-weight: 600;
          letter-spacing: 0.18em;
          color: var(--accent);
        }
        .brand-sep {
          color: var(--text-dimmer);
        }
        .brand-sub {
          font-size: 13px;
          color: var(--text-dim);
        }
        .brand-ver {
          font-family: var(--mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--text-dimmer);
          text-transform: uppercase;
        }
        .layout {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 340px;
          min-height: 0;
        }
        .stage {
          padding: 24px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: var(--bg);
          overflow: auto;
          gap: 14px;
        }
        .cal-error {
          width: 100%;
          max-width: 640px;
          padding: 10px 14px;
          background: rgba(184, 60, 60, 0.12);
          border: 1px solid var(--bad, #b83c3c);
          border-radius: 6px;
          color: var(--text);
          font-size: 12px;
          line-height: 1.5;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .cal-error strong {
          color: var(--bad, #b83c3c);
        }
        .cal-error-close {
          background: none;
          border: none;
          color: var(--text-dim);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 0 4px;
          flex-shrink: 0;
        }
        .cal-error-close:hover {
          color: var(--text);
        }
        .dropzone {
          width: 100%;
          max-width: 640px;
          aspect-ratio: 16 / 9;
          border: 1.5px dashed var(--border-strong);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
        }
        .dropzone:hover {
          border-color: var(--accent-dim);
          background: var(--bg-elev);
        }
        .dz-inner {
          text-align: center;
        }
        .dz-icon {
          font-family: var(--mono);
          font-size: 22px;
          color: var(--accent);
          margin-bottom: 14px;
        }
        .dz-title {
          font-size: 15px;
          margin-bottom: 8px;
        }
        .dz-hint {
          font-size: 12px;
          color: var(--text-dim);
          line-height: 1.7;
        }
        .dz-error {
          margin-top: 14px;
          font-size: 12px;
          color: var(--bad);
          font-family: var(--mono);
        }
        .canvas-host {
          position: relative;
          max-width: 100%;
        }
        .court-canvas {
          max-width: 100%;
          max-height: calc(100vh - 130px);
          display: block;
          border-radius: 6px;
          border: 1px solid var(--border);
          cursor: crosshair;
        }
        .loupe {
          position: absolute;
          z-index: 50;
          pointer-events: none;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .loupe-lens {
          width: ${LOUPE_SIZE}px;
          height: ${LOUPE_SIZE}px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid var(--accent);
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.7);
          background: var(--bg);
        }
        .loupe-cap {
          font-family: var(--mono);
          font-size: 10px;
          line-height: 1;
          color: var(--accent);
          background: rgba(10, 10, 10, 0.7);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .guide-pill {
          position: absolute;
          top: 10px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 49;
          pointer-events: none;
          font-family: var(--mono);
          font-size: 11px;
          letter-spacing: 0.02em;
          color: var(--accent);
          background: rgba(10, 10, 10, 0.72);
          border: 1px solid var(--accent-dim);
          padding: 4px 10px;
          border-radius: 999px;
          white-space: nowrap;
          max-width: calc(100% - 24px);
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .panel {
          border-left: 1px solid var(--border);
          background: var(--bg-elev);
          padding: 8px 0;
          overflow-y: auto;
        }
        .verify {
          padding: 16px 20px;
        }
        .verify-ok,
        .verify-wait {
          font-size: 12px;
          line-height: 1.6;
          margin-bottom: 14px;
        }
        .verify-ok {
          color: var(--ok);
        }
        .verify-wait {
          color: var(--text-dim);
        }
        .muted {
          color: var(--text-dim);
          font-size: 12px;
          line-height: 1.6;
        }
        .tiny {
          font-size: 11px;
          margin-top: 10px;
        }
        code {
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--accent);
        }
        .kv {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 4px 12px;
          font-size: 12px;
        }
        .kv .k {
          font-family: var(--mono);
          color: var(--text-dimmer);
          text-transform: uppercase;
          font-size: 10px;
          align-self: center;
        }
        .kv .v {
          color: var(--text);
          word-break: break-all;
        }
        .corners {
          list-style: none;
          margin: 12px 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .corner-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 6px;
          background: var(--surface);
          border: 1px solid transparent;
          font-size: 12px;
        }
        .corner-row.done {
          border-color: var(--border);
          cursor: pointer;
        }
        .corner-row.next {
          border-color: var(--accent);
          background: var(--surface-2);
        }
        .corner-row.sel {
          border-color: var(--accent);
          box-shadow: inset 2px 0 0 var(--accent);
        }
        .corner-num {
          font-family: var(--mono);
          width: 18px;
          height: 18px;
          border-radius: 4px;
          background: var(--bg);
          color: var(--text-dim);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
        }
        .corner-row.done .corner-num {
          background: var(--accent-dim);
          color: var(--text);
        }
        .corner-label {
          flex: 1;
        }
        .corner-coord {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--text-dim);
        }
        .corner-row.next .corner-coord {
          color: var(--accent);
        }
        .seg {
          display: flex;
          gap: 6px;
        }
        .seg button {
          flex: 1;
          padding: 8px;
          font-size: 12px;
          border-radius: 6px;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text-dim);
        }
        .seg button.seg-on {
          background: var(--accent-dim);
          border-color: var(--accent);
          color: var(--text);
        }
        .zoom-ctl {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .zoom-btn {
          width: 34px;
          height: 34px;
          border-radius: 6px;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text);
          font-size: 18px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .zoom-btn:not(:disabled):hover {
          border-color: var(--accent);
          color: var(--accent);
        }
        .zoom-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .zoom-val {
          font-family: var(--mono);
          font-size: 14px;
          color: var(--text);
          min-width: 36px;
          text-align: center;
        }
        .field {
          margin-bottom: 10px;
        }
        .field label {
          display: block;
          font-family: var(--mono);
          font-size: 10px;
          text-transform: uppercase;
          color: var(--text-dimmer);
          margin-bottom: 4px;
        }
        .field input {
          width: 100%;
          padding: 7px 9px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-size: 12px;
        }
        .field input:focus {
          outline: none;
          border-color: var(--accent-dim);
        }
        .btn {
          display: block;
          width: 100%;
          padding: 9px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          transition: opacity 0.15s, background 0.15s;
        }
        .btn.ghost {
          margin-top: 10px;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text-dim);
        }
        .btn.ghost:hover {
          color: var(--text);
          border-color: var(--border-strong);
        }
        .btn.primary {
          background: var(--accent);
          color: #0a0a0a;
          font-weight: 600;
        }
        .btn.primary:not(:disabled):hover {
          opacity: 0.9;
        }
        @media (max-width: 820px) {
          .layout {
            grid-template-columns: 1fr;
          }
          .panel {
            border-left: none;
            border-top: 1px solid var(--border);
          }
        }
      `}</style>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="section">
      <h2>{title}</h2>
      {children}
      <style jsx>{`
        .section {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
        }
        h2 {
          font-family: var(--mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-dimmer);
          margin-bottom: 10px;
        }
      `}</style>
    </div>
  );
}
