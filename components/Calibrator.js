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
// Zoom de la lupa
const LOUPE_ZOOM = 6;
const LOUPE_SIZE = 150;

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
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (objectUrlRef.current === url) objectUrlRef.current = null;
      if (!mountedRef.current) return;
      setLoadError("No se pudo decodificar la imagen.");
    };
    img.src = url;
    setImageName(file.name);
    // Sugerir nombre de video a partir del frame
    const base = file.name.replace(/\.(png|jpe?g|webp)$/i, "");
    setVideoRef(base + ".mp4");
  }, []);

  // Liberar la URL del blob al desmontar el componente
  useEffect(() => {
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
    // ¿Tocó una esquina existente? → arrastrar
    for (let i = 0; i < corners.length; i++) {
      const dx = corners[i].x - p.x;
      const dy = corners[i].y - p.y;
      if (Math.hypot(dx, dy) < GRAB_RADIUS) {
        setDragIndex(i);
        return;
      }
    }
    // Si faltan esquinas, colocar la siguiente
    if (corners.length < 4) {
      setCorners([...corners, { x: p.x, y: p.y }]);
    }
  };

  const onCanvasMove = (e) => {
    if (!imageLoaded) return;
    const p = toNatural(e.clientX, e.clientY);
    setCursor({ x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY });
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
  }, [imageLoaded, corners, halfCourt, ppm]);

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
    const src = LOUPE_SIZE / LOUPE_ZOOM;
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
    // Cruz
    ctx.strokeStyle = "#5fd0d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_SIZE / 2, 0);
    ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    ctx.moveTo(0, LOUPE_SIZE / 2);
    ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    ctx.stroke();
  }, [cursor, imageLoaded, dragIndex]);

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
  };

  const ready = corners.length === 4;
  const nextCorner = corners.length < 4 ? corners.length : -1;

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
                {loadError && <div className="dz-error">{loadError}</div>}
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
              {cursor && (
                <div
                  className="loupe"
                  style={{
                    left: Math.max(
                      12,
                      Math.min(
                        cursor.clientX + 24,
                        typeof window !== "undefined"
                          ? window.innerWidth - LOUPE_SIZE - 12
                          : 0
                      )
                    ),
                    // Cuando el cursor está cerca del borde superior, mostrar
                    // la lupa debajo del cursor para que no se corte arriba.
                    top:
                      cursor.clientY - LOUPE_SIZE - 24 < 12
                        ? cursor.clientY + 24
                        : cursor.clientY - LOUPE_SIZE - 24,
                  }}
                >
                  <canvas
                    ref={loupeRef}
                    width={LOUPE_SIZE}
                    height={LOUPE_SIZE}
                  />
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
              Después puedes arrastrar cualquiera para corregir.
            </p>
            <ol className="corners">
              {CORNER_LABELS.map((label, i) => {
                const c = corners[i];
                const isNext = i === nextCorner;
                return (
                  <li
                    key={i}
                    className={
                      "corner-row" +
                      (c ? " done" : "") +
                      (isNext ? " next" : "")
                    }
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
          align-items: center;
          justify-content: center;
          background: var(--bg);
          overflow: auto;
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
          position: fixed;
          width: ${LOUPE_SIZE}px;
          height: ${LOUPE_SIZE}px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid var(--accent);
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.7);
          pointer-events: none;
          z-index: 50;
          background: var(--bg);
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
        }
        .corner-row.next {
          border-color: var(--accent);
          background: var(--surface-2);
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
