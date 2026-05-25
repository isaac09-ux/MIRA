"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  buildCalibration,
  solveHomography,
  invert3x3,
  projectPoint,
  courtLines,
  courtPointUV,
  referencePoints,
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

// Parsea "ANCHOxALTO" (acepta x, X, *, espacios) → {w,h} o null.
const parseRes = (str) => {
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(str || "");
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
};

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
  // Marcas en coords naturales: [{id, x, y}] — cada una ligada a un punto de
  // referencia conocido (esquina o punto interno de la cancha).
  const [marks, setMarks] = useState([]);
  const [dragId, setDragId] = useState(null);
  // Punto "enfocado": el que se coloca/ajusta al hacer clic o con las flechas.
  // Arranca en la primera esquina para indicar por dónde empezar.
  const [selectedId, setSelectedId] = useState("cercana_izq");
  const [loupeZoom, setLoupeZoom] = useState(LOUPE_DEFAULT_ZOOM);
  const [halfCourt, setHalfCourt] = useState(false);
  const [ppm, setPpm] = useState(40);
  const [videoRef, setVideoRef] = useState("video.mp4");
  // Resolución objetivo opcional ("ANCHOxALTO") del video que procesará CLARA;
  // si difiere del frame cargado, se advierte al exportar (bug de cal cruzada).
  const [expectedRes, setExpectedRes] = useState("");
  const [cursor, setCursor] = useState(null); // {x,y,clientX,clientY,fx,fy}
  const [naturalSize, setNaturalSize] = useState([0, 0]);
  const [loadError, setLoadError] = useState("");

  // Catálogo de puntos marcables según el tipo de cancha.
  const catalog = referencePoints(halfCourt);
  const markById = Object.fromEntries(marks.map((m) => [m.id, m]));

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
      setMarks([]);
      setDragId(null);
      // Dejar listo el primer punto para marcar (ambos catálogos empiezan
      // por la esquina cercana izquierda).
      setSelectedId("cercana_izq");
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

  // Coloca/mueve la marca de un punto (upsert) preservando el orden.
  const placeMark = (id, x, y) => {
    const cx = Math.max(0, Math.min(naturalSize[0], x));
    const cy = Math.max(0, Math.min(naturalSize[1], y));
    setMarks((prev) =>
      prev.some((m) => m.id === id)
        ? prev.map((m) => (m.id === id ? { id, x: cx, y: cy } : m))
        : [...prev, { id, x: cx, y: cy }]
    );
  };

  // ── Eventos de mouse sobre el canvas ─────────────────────
  const onCanvasDown = (e) => {
    if (!imageLoaded) return;
    const p = toNatural(e.clientX, e.clientY);
    // ¿Tocó una marca existente? → seleccionarla y arrastrar
    for (const m of marks) {
      if (Math.hypot(m.x - p.x, m.y - p.y) < GRAB_RADIUS) {
        setDragId(m.id);
        setSelectedId(m.id);
        return;
      }
    }
    // Si hay un punto seleccionado, colocar/mover su marca aquí.
    if (selectedId) {
      const wasMarked = !!markById[selectedId];
      placeMark(selectedId, p.x, p.y);
      setDragId(selectedId);
      // Si es nuevo, avanzar al siguiente punto sin marcar (marcado en orden).
      if (!wasMarked) {
        const nextUp = catalog.find(
          (c) => c.id !== selectedId && !markById[c.id]
        );
        if (nextUp) setSelectedId(nextUp.id);
      }
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
    if (dragId) placeMark(dragId, p.x, p.y);
  };

  const onCanvasUp = () => setDragId(null);
  const onCanvasLeave = () => {
    // Solo escondemos la lupa: el drag sigue vivo mientras el botón esté
    // presionado — un mouseup global lo termina (ver useEffect más abajo).
    setCursor(null);
  };

  // Mouseup global: termina cualquier drag aunque el usuario suelte el botón
  // fuera del canvas.
  useEffect(() => {
    if (!dragId) return;
    const up = () => setDragId(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragId]);

  // Teclado: flechas mueven el punto enfocado 1 px (Shift = 10 px) para
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
      if (!selectedId) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      setMarks((prev) =>
        prev.map((m) =>
          m.id === selectedId
            ? {
                id: m.id,
                x: Math.max(0, Math.min(naturalSize[0], m.x + dx)),
                y: Math.max(0, Math.min(naturalSize[1], m.y + dy)),
              }
            : m
        )
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imageLoaded, selectedId, naturalSize]);

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

    const refById = Object.fromEntries(
      referencePoints(halfCourt).map((p) => [p.id, p])
    );

    // Verificación: cancha proyectada de vuelta sobre el frame usando la
    // homografía de N puntos (exacta con 4, mínimos cuadrados con 5+).
    if (marks.length >= 4) {
      try {
        const src = [];
        const dst = [];
        for (const m of marks) {
          const r = refById[m.id];
          if (!r) continue;
          src.push([m.x, m.y]);
          dst.push(courtPointUV(halfCourt, ppm, r.s, r.t));
        }
        if (src.length >= 4) {
          const H = solveHomography(src, dst);
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
        }
      } catch {
        /* configuración degenerada — se ignora hasta que el usuario ajuste */
      }
    }

    // Marcas: esquinas en cálido, puntos internos en cian.
    marks.forEach((m) => {
      const r = refById[m.id];
      const isCorner = r && r.corner !== null;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 7 * S, 0, Math.PI * 2);
      ctx.fillStyle = isCorner ? "#b87a6a" : "#5fd0d8";
      ctx.fill();
      ctx.lineWidth = 2 * S;
      ctx.strokeStyle = "#0a0a0a";
      ctx.stroke();
      // Etiqueta corta
      ctx.font = `${12 * S}px ui-monospace, monospace`;
      ctx.fillStyle = "#ebe9e3";
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 3 * S;
      const label = r ? r.short : "?";
      ctx.strokeText(label, m.x + 10 * S, m.y - 9 * S);
      ctx.fillText(label, m.x + 10 * S, m.y - 9 * S);
    });

    // Anillo punteado sobre el punto enfocado: indica cuál mueven las flechas.
    const sm = marks.find((m) => m.id === selectedId);
    if (sm) {
      ctx.beginPath();
      ctx.arc(sm.x, sm.y, 13 * S, 0, Math.PI * 2);
      ctx.setLineDash([4 * S, 3 * S]);
      ctx.lineWidth = 2 * S;
      ctx.strokeStyle = "#5fd0d8";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [imageLoaded, marks, halfCourt, ppm, selectedId]);

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
  const ready = marks.length >= 4;
  const missing = Math.max(0, 4 - marks.length);
  const selectedRef = catalog.find((c) => c.id === selectedId) || null;
  const selectedMarked = !!(selectedId && markById[selectedId]);

  // Resolución objetivo opcional vs. resolución real del frame.
  const parsedRes = parseRes(expectedRes);
  const resMismatch =
    imageLoaded &&
    parsedRes &&
    (parsedRes.w !== naturalSize[0] || parsedRes.h !== naturalSize[1]);

  const exportJson = () => {
    if (marks.length < 4) return;
    // Aviso de resolución cruzada — no bloquea, el usuario confirma.
    if (resMismatch) {
      const ok = window.confirm(
        `La resolución objetivo (${parsedRes.w}×${parsedRes.h}) no coincide con ` +
          `el frame cargado (${naturalSize[0]}×${naturalSize[1]}).\n\n` +
          `El cal.json se generará para ${naturalSize[0]}×${naturalSize[1]}. Si ` +
          `CLARA procesa un video de otra resolución, la calibración fallará.\n\n` +
          `¿Exportar de todos modos?`
      );
      if (!ok) return;
    }
    let cal;
    try {
      cal = buildCalibration({
        points: marks,
        frameShape: [naturalSize[1], naturalSize[0]],
        halfCourt,
        videoReference: videoRef,
        ppm,
      });
    } catch (err) {
      // Puntos degenerados (colineales o coincidentes) → homografía inválida
      alert(
        "No se pudo calcular la homografía: " +
          (err?.message || "puntos inválidos") +
          ".\nAjusta los puntos y vuelve a intentar."
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
    setMarks([]);
    setDragId(null);
    setSelectedId("cercana_izq");
  };

  // Cambiar el tipo de cancha cambia el catálogo de puntos; reiniciamos las
  // marcas para no dejar ids huérfanos del catálogo anterior.
  const changeCourt = (half) => {
    if (half === halfCourt) return;
    setHalfCourt(half);
    setMarks([]);
    setDragId(null);
    setSelectedId("cercana_izq");
  };

  // Micro-guía: qué punto toca marcar ahora o cuál estás ajustando.
  let guideText;
  const draggingRef = dragId ? catalog.find((c) => c.id === dragId) : null;
  if (draggingRef) {
    guideText = `Ajustando: ${draggingRef.label}`;
  } else if (selectedRef && !selectedMarked) {
    guideText = `Marca: ${selectedRef.label}`;
  } else if (selectedRef && selectedMarked) {
    guideText = `${selectedRef.label} · flechas = 1 px`;
  } else {
    guideText = "Elige un punto en el panel para marcar";
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

          <Section title="Puntos de referencia">
            <p className="muted">
              Marca al menos 4 puntos que <strong>sí</strong> se vean — esquinas
              o puntos internos de la cancha. Elige uno en la lista, clic en el
              frame (usa la lupa), y afina con las flechas (Shift = 10 px).
              Puedes arrastrar para corregir.
            </p>
            <div className="pts-count">
              <span className={ready ? "ok" : "warn"}>{marks.length}</span>{" "}
              marcado{marks.length === 1 ? "" : "s"} · mínimo 4
            </div>
            <ul className="corners">
              {catalog.map((c) => {
                const m = markById[c.id];
                const isSel = c.id === selectedId;
                return (
                  <li
                    key={c.id}
                    className={
                      "corner-row" +
                      (m ? " done" : "") +
                      (isSel ? " sel" : "")
                    }
                    onClick={() => setSelectedId(c.id)}
                  >
                    <span className="corner-num">{c.short}</span>
                    <span className="corner-label">{c.label}</span>
                    <span className="corner-coord">
                      {m
                        ? `${Math.round(m.x)}, ${Math.round(m.y)}`
                        : isSel
                        ? "← marca este"
                        : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {marks.length > 0 && (
              <button className="btn ghost" onClick={reset}>
                Reiniciar puntos
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
                onClick={() => changeCourt(false)}
              >
                Completa 9×18
              </button>
              <button
                className={halfCourt ? "seg-on" : ""}
                onClick={() => changeCourt(true)}
              >
                Media 9×9
              </button>
            </div>
            <p className="muted tiny">
              Cambiar el tipo de cancha reinicia los puntos marcados.
            </p>
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
            <div className="field">
              <label>Resolución del video (opcional)</label>
              <input
                type="text"
                value={expectedRes}
                placeholder={
                  imageLoaded
                    ? `${naturalSize[0]}x${naturalSize[1]}`
                    : "ej. 1920x1080"
                }
                onChange={(e) => setExpectedRes(e.target.value)}
              />
              {resMismatch ? (
                <p className="res-warn" role="alert">
                  ⚠ No coincide con el frame ({naturalSize[0]}×{naturalSize[1]}).
                  El cal.json es válido solo a la resolución del frame.
                </p>
              ) : (
                <p className="muted tiny">
                  Si CLARA procesa otra resolución que el frame, avisamos al
                  exportar.
                </p>
              )}
            </div>
          </Section>

          {/* Verificación + export */}
          <div className="verify">
            {ready ? (
              <p className="verify-ok">
                ✓ Cancha proyectada en cian. Verifica que calce con las líneas
                reales antes de exportar — si no, arrastra los puntos.
              </p>
            ) : (
              <p className="verify-wait">
                Faltan {missing} punto{missing === 1 ? "" : "s"} (mínimo 4).
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
          cursor: pointer;
        }
        .corner-row:hover {
          border-color: var(--border-strong);
        }
        .corner-row.done {
          border-color: var(--border);
        }
        .corner-row.sel {
          border-color: var(--accent);
          background: var(--surface-2);
          box-shadow: inset 2px 0 0 var(--accent);
        }
        .corner-num {
          font-family: var(--mono);
          min-width: 22px;
          height: 18px;
          padding: 0 5px;
          border-radius: 4px;
          background: var(--bg);
          color: var(--text-dim);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10.5px;
          flex-shrink: 0;
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
          white-space: nowrap;
        }
        .corner-row.sel .corner-coord {
          color: var(--accent);
        }
        .pts-count {
          font-size: 12px;
          color: var(--text-dim);
          margin-top: 2px;
        }
        .pts-count .ok {
          color: var(--ok);
          font-family: var(--mono);
          font-weight: 600;
        }
        .pts-count .warn {
          color: var(--accent);
          font-family: var(--mono);
          font-weight: 600;
        }
        .res-warn {
          font-size: 11px;
          line-height: 1.5;
          margin-top: 6px;
          color: var(--bad, #b83c3c);
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
