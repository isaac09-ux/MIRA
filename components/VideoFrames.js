"use client";

import { useRef, useState, useEffect, useCallback } from "react";

// Tope de seguridad: extraer "todos los frames" en un video largo puede agotar
// la memoria del navegador. Con ~200 frames a 1080p en JPEG se queda manejable.
const SAFE_MAX_FRAMES = 200;

// Mínimo de separación entre frames cuando se extrae el video completo.
const MIN_INTERVAL = 0.1;

export default function VideoFrames({ onUseFrame }) {
  const videoElRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const objectUrlRef = useRef(null);
  const seekResolverRef = useRef(null);

  const [videoName, setVideoName] = useState("");
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [naturalSize, setNaturalSize] = useState([0, 0]);
  const [loadError, setLoadError] = useState("");
  const [playing, setPlaying] = useState(false);

  const [intervalSec, setIntervalSec] = useState(1);
  const [extracted, setExtracted] = useState([]); // [{time, url}]
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);

  // ── Limpieza de URLs ──────────────────────────────────────
  const revokeExtracted = useCallback((list) => {
    list.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      revokeExtracted(extracted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Carga de archivo ──────────────────────────────────────
  const loadFile = useCallback(
    (file) => {
      if (!file || !file.type.startsWith("video/")) {
        setLoadError("El archivo no es un video válido.");
        return;
      }
      setLoadError("");
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      revokeExtracted(extracted);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setVideoName(file.name);
      setExtracted([]);
      setExtractProgress(0);
      setVideoLoaded(false);
      setDuration(0);
      setCurrentTime(0);
      setPlaying(false);
      // El <video> ya está montado; solo cambiamos src.
      if (videoElRef.current) {
        videoElRef.current.pause();
        videoElRef.current.src = url;
        videoElRef.current.load();
      }
    },
    [extracted, revokeExtracted]
  );

  const onDrop = (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  };

  // ── Eventos del <video> ───────────────────────────────────
  const onLoadedMetadata = (e) => {
    const v = e.target;
    setDuration(v.duration || 0);
    setNaturalSize([v.videoWidth, v.videoHeight]);
    setVideoLoaded(true);
    setCurrentTime(0);
  };

  const onTimeUpdate = (e) => {
    setCurrentTime(e.target.currentTime);
  };

  const onSeeked = () => {
    // Si hay una extracción de "todos los frames" esperando este seek,
    // la resolvemos.
    if (seekResolverRef.current) {
      const r = seekResolverRef.current;
      seekResolverRef.current = null;
      r();
    }
  };

  const onVideoError = () => {
    setLoadError("No se pudo decodificar el video.");
    setVideoLoaded(false);
  };

  const onPlay = () => setPlaying(true);
  const onPause = () => setPlaying(false);

  // ── Controles de reproducción ─────────────────────────────
  const togglePlay = () => {
    const v = videoElRef.current;
    if (!v || !videoLoaded) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seekTo = (t) => {
    const v = videoElRef.current;
    if (!v || !videoLoaded) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
  };

  const stepFrame = (dir) => {
    // Sin conocer el fps real del contenedor, asumimos ~30fps como paso.
    seekTo(currentTime + dir * (1 / 30));
  };

  const onScrub = (e) => {
    seekTo(Number(e.target.value));
  };

  // ── Captura del frame actual al canvas ────────────────────
  const drawCurrentToCanvas = useCallback(() => {
    const v = videoElRef.current;
    const cv = canvasRef.current;
    if (!v || !cv) return null;
    cv.width = v.videoWidth || naturalSize[0];
    cv.height = v.videoHeight || naturalSize[1];
    const ctx = cv.getContext("2d");
    ctx.drawImage(v, 0, 0, cv.width, cv.height);
    return cv;
  }, [naturalSize]);

  const blobFromCanvas = (cv, type = "image/png", quality) =>
    new Promise((resolve) => {
      cv.toBlob((b) => resolve(b), type, quality);
    });

  // ── Extraer el frame visible actual ──────────────────────
  const extractCurrentFrame = async () => {
    if (!videoLoaded) return;
    const cv = drawCurrentToCanvas();
    if (!cv) return;
    const blob = await blobFromCanvas(cv, "image/png");
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setExtracted((prev) => [
      ...prev,
      { time: videoElRef.current.currentTime, url },
    ]);
  };

  // ── Mandar el frame actual al calibrador ─────────────────
  const sendCurrentToCalibrator = async () => {
    if (!videoLoaded || !onUseFrame) return;
    const cv = drawCurrentToCanvas();
    if (!cv) return;
    const blob = await blobFromCanvas(cv, "image/png");
    if (!blob) return;
    const base = videoName.replace(/\.[^.]+$/, "") || "frame";
    const safeT = currentTime.toFixed(2).replace(".", "_");
    const file = new File([blob], `${base}_t${safeT}.png`, {
      type: "image/png",
    });
    onUseFrame(file);
  };

  // ── Extraer frames a intervalos regulares ────────────────
  const extractAllFrames = async () => {
    if (!videoLoaded || extracting) return;
    const v = videoElRef.current;
    if (!v) return;
    const step = Math.max(MIN_INTERVAL, Number(intervalSec) || MIN_INTERVAL);
    let count = Math.floor(duration / step) + 1;
    if (count > SAFE_MAX_FRAMES) count = SAFE_MAX_FRAMES;
    if (count <= 0) return;

    setExtracting(true);
    setExtractProgress(0);
    // Limpiar lo previo para no dejar URLs colgadas.
    revokeExtracted(extracted);
    const out = [];

    const wasPlaying = !v.paused;
    v.pause();

    try {
      for (let i = 0; i < count; i++) {
        const t = Math.min(i * step, duration);
        // Esperar al evento seeked antes de pintar — si no, drawImage
        // saca el frame anterior.
        await new Promise((resolve) => {
          seekResolverRef.current = resolve;
          v.currentTime = t;
        });
        const cv = drawCurrentToCanvas();
        if (!cv) break;
        // JPEG en miniaturas para no explotar la memoria.
        const blob = await blobFromCanvas(cv, "image/jpeg", 0.85);
        if (!blob) continue;
        out.push({ time: t, url: URL.createObjectURL(blob) });
        setExtractProgress(Math.round(((i + 1) / count) * 100));
      }
    } finally {
      seekResolverRef.current = null;
      setExtracted(out);
      setExtracting(false);
      if (wasPlaying) v.play();
    }
  };

  // ── Descargar / usar / borrar frame extraído ─────────────
  const downloadExtracted = (f) => {
    const a = document.createElement("a");
    a.href = f.url;
    const base = videoName.replace(/\.[^.]+$/, "") || "frame";
    a.download = `${base}_t${f.time.toFixed(2).replace(".", "_")}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const useExtracted = async (f) => {
    if (!onUseFrame) return;
    // Cargamos la URL del blob como File para pasarlo al Calibrator.
    const res = await fetch(f.url);
    const blob = await res.blob();
    const base = videoName.replace(/\.[^.]+$/, "") || "frame";
    const file = new File(
      [blob],
      `${base}_t${f.time.toFixed(2).replace(".", "_")}.png`,
      { type: blob.type || "image/png" }
    );
    onUseFrame(file);
  };

  const clearExtracted = () => {
    revokeExtracted(extracted);
    setExtracted([]);
    setExtractProgress(0);
  };

  // ── Formato de tiempo mm:ss.cc ────────────────────────────
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return "00:00.00";
    const m = Math.floor(s / 60);
    const ss = s - m * 60;
    return `${String(m).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
  };

  const seekStep = duration > 0 ? Math.max(0.01, duration / 1000) : 0.01;

  return (
    <div className="vf-wrap">
      <div className="layout">
        {/* ── Stage ── */}
        <main className="stage">
          {!videoLoaded ? (
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="dz-inner">
                <div className="dz-icon">[ ▶ ]</div>
                <div className="dz-title">Carga un video</div>
                <div className="dz-hint">
                  Arrastra un .mp4 / .webm / .mov aquí, o haz clic para elegir.
                  <br />
                  Puedes navegar y extraer un frame puntual o todos a intervalos.
                </div>
                {loadError && <div className="dz-error">{loadError}</div>}
              </div>
              {/* El <video> queda montado pero oculto antes de cargar para que
                  el src se pueda asignar sin remount. */}
              <video
                ref={videoElRef}
                style={{ display: "none" }}
                preload="metadata"
                playsInline
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onSeeked={onSeeked}
                onError={onVideoError}
                onPlay={onPlay}
                onPause={onPause}
              />
            </div>
          ) : (
            <div className="player-host">
              <video
                ref={videoElRef}
                className="video-el"
                preload="metadata"
                playsInline
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onSeeked={onSeeked}
                onError={onVideoError}
                onPlay={onPlay}
                onPause={onPause}
              />

              {/* ── Barra de navegación del video ── */}
              <div className="navbar" aria-label="Barra de navegación del video">
                <button
                  className="navbtn"
                  onClick={() => seekTo(0)}
                  title="Ir al inicio"
                  aria-label="Ir al inicio"
                >
                  ⏮
                </button>
                <button
                  className="navbtn"
                  onClick={() => stepFrame(-1)}
                  title="Frame anterior"
                  aria-label="Frame anterior"
                >
                  ◀
                </button>
                <button
                  className="navbtn play"
                  onClick={togglePlay}
                  title={playing ? "Pausar" : "Reproducir"}
                  aria-label={playing ? "Pausar" : "Reproducir"}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <button
                  className="navbtn"
                  onClick={() => stepFrame(1)}
                  title="Frame siguiente"
                  aria-label="Frame siguiente"
                >
                  ▶
                </button>
                <button
                  className="navbtn"
                  onClick={() => seekTo(duration)}
                  title="Ir al final"
                  aria-label="Ir al final"
                >
                  ⏭
                </button>
                <div className="scrubber-wrap">
                  <input
                    type="range"
                    className="scrubber"
                    min={0}
                    max={duration || 0}
                    step={seekStep}
                    value={Math.min(currentTime, duration || 0)}
                    onChange={onScrub}
                    aria-label="Posición del video"
                  />
                  {/* Marcadores de frames extraídos */}
                  {duration > 0 && extracted.length > 0 && (
                    <div className="markers" aria-hidden="true">
                      {extracted.map((f, i) => (
                        <span
                          key={i}
                          className="marker"
                          style={{ left: `${(f.time / duration) * 100}%` }}
                          title={`Frame en ${fmtTime(f.time)}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="timecode" aria-live="off">
                  {fmtTime(currentTime)} / {fmtTime(duration)}
                </div>
              </div>

              {/* ── Galería de frames extraídos ── */}
              {extracted.length > 0 && (
                <div className="gallery">
                  <div className="gallery-head">
                    <span className="gallery-title">
                      Frames extraídos ({extracted.length})
                    </span>
                    <button className="link" onClick={clearExtracted}>
                      Limpiar
                    </button>
                  </div>
                  <div className="thumbs">
                    {extracted.map((f, i) => (
                      <div key={i} className="thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f.url} alt={`Frame en ${fmtTime(f.time)}`} />
                        <div className="thumb-time">{fmtTime(f.time)}</div>
                        <div className="thumb-actions">
                          <button
                            className="thumb-btn"
                            onClick={() => seekTo(f.time)}
                            title="Saltar a este punto"
                          >
                            ↩
                          </button>
                          <button
                            className="thumb-btn"
                            onClick={() => useExtracted(f)}
                            title="Calibrar con este frame"
                          >
                            ⊕
                          </button>
                          <button
                            className="thumb-btn"
                            onClick={() => downloadExtracted(f)}
                            title="Descargar PNG"
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={(e) => loadFile(e.target.files[0])}
          />
          {/* Canvas auxiliar para capturar frames. Off-screen. */}
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </main>

        {/* ── Panel ── */}
        <aside className="panel">
          <Section title="Video">
            {videoLoaded ? (
              <div className="kv">
                <span className="k">archivo</span>
                <span className="v">{videoName}</span>
                <span className="k">resolución</span>
                <span className="v">
                  {naturalSize[0]} × {naturalSize[1]}
                </span>
                <span className="k">duración</span>
                <span className="v">{fmtTime(duration)}</span>
                <span className="k">tiempo</span>
                <span className="v">{fmtTime(currentTime)}</span>
              </div>
            ) : (
              <p className="muted">Ningún video cargado.</p>
            )}
            {videoLoaded && (
              <button
                className="btn ghost"
                onClick={() => fileInputRef.current?.click()}
              >
                Cambiar video
              </button>
            )}
          </Section>

          <Section title="Frame actual">
            <p className="muted">
              Navega con el scrubber y los botones <code>◀ ▶</code> para
              avanzar frame a frame. Extrae el frame visible para usarlo
              después o mándalo directo al calibrador.
            </p>
            <button
              className="btn ghost"
              disabled={!videoLoaded}
              onClick={extractCurrentFrame}
            >
              Extraer este frame
            </button>
            <button
              className="btn primary"
              disabled={!videoLoaded}
              onClick={sendCurrentToCalibrator}
            >
              Calibrar con este frame
            </button>
          </Section>

          <Section title="Separar por frames">
            <p className="muted">
              Extrae todo el video a intervalos regulares. Tope de seguridad:{" "}
              {SAFE_MAX_FRAMES} frames para no agotar memoria.
            </p>
            <div className="field">
              <label>Intervalo (segundos)</label>
              <input
                type="number"
                value={intervalSec}
                min={MIN_INTERVAL}
                step="0.1"
                onChange={(e) =>
                  setIntervalSec(Math.max(MIN_INTERVAL, Number(e.target.value) || MIN_INTERVAL))
                }
              />
            </div>
            {duration > 0 && (
              <p className="muted tiny">
                ≈{" "}
                {Math.min(
                  SAFE_MAX_FRAMES,
                  Math.floor(duration / Math.max(MIN_INTERVAL, intervalSec)) + 1
                )}{" "}
                frames a este intervalo
              </p>
            )}
            <button
              className="btn ghost"
              disabled={!videoLoaded || extracting}
              onClick={extractAllFrames}
            >
              {extracting
                ? `Extrayendo… ${extractProgress}%`
                : "Extraer todos"}
            </button>
            {extracting && (
              <div className="progress" aria-hidden="true">
                <div
                  className="progress-bar"
                  style={{ width: `${extractProgress}%` }}
                />
              </div>
            )}
          </Section>
        </aside>
      </div>

      <style jsx>{`
        .vf-wrap {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
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
          justify-content: flex-start;
          background: var(--bg);
          overflow: auto;
          gap: 14px;
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
        .player-host {
          width: 100%;
          max-width: 960px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .video-el {
          width: 100%;
          max-height: calc(100vh - 320px);
          background: #000;
          border-radius: 6px;
          border: 1px solid var(--border);
          display: block;
        }
        .navbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
        }
        .navbtn {
          width: 30px;
          height: 30px;
          border-radius: 6px;
          background: var(--bg);
          border: 1px solid var(--border);
          color: var(--text-dim);
          font-size: 11px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--mono);
        }
        .navbtn:hover:not(:disabled) {
          color: var(--text);
          border-color: var(--border-strong);
        }
        .navbtn.play {
          background: var(--accent-dim);
          color: var(--text);
          border-color: var(--accent);
        }
        .scrubber-wrap {
          flex: 1;
          position: relative;
          padding: 0 4px;
        }
        .scrubber {
          width: 100%;
          accent-color: var(--accent);
          cursor: pointer;
        }
        .markers {
          position: absolute;
          top: 50%;
          left: 4px;
          right: 4px;
          height: 12px;
          transform: translateY(-50%);
          pointer-events: none;
        }
        .marker {
          position: absolute;
          top: 0;
          width: 2px;
          height: 12px;
          background: var(--accent);
          opacity: 0.85;
          transform: translateX(-50%);
        }
        .timecode {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--text-dim);
          min-width: 120px;
          text-align: right;
        }
        .gallery {
          width: 100%;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
        }
        .gallery-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .gallery-title {
          font-family: var(--mono);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--text-dimmer);
        }
        .link {
          background: none;
          border: none;
          font-size: 11px;
          color: var(--text-dim);
          text-decoration: underline;
          cursor: pointer;
        }
        .link:hover {
          color: var(--text);
        }
        .thumbs {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          gap: 8px;
        }
        .thumb {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 6px;
          overflow: hidden;
          position: relative;
        }
        .thumb img {
          display: block;
          width: 100%;
          aspect-ratio: 16 / 9;
          object-fit: cover;
          background: #000;
        }
        .thumb-time {
          padding: 4px 6px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--text-dim);
        }
        .thumb-actions {
          position: absolute;
          top: 4px;
          right: 4px;
          display: flex;
          gap: 4px;
        }
        .thumb-btn {
          width: 22px;
          height: 22px;
          border-radius: 4px;
          background: rgba(10, 10, 10, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: var(--text);
          font-size: 11px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .thumb-btn:hover {
          background: var(--accent-dim);
          border-color: var(--accent);
        }
        .panel {
          border-left: 1px solid var(--border);
          background: var(--bg-elev);
          padding: 8px 0;
          overflow-y: auto;
        }
        .muted {
          color: var(--text-dim);
          font-size: 12px;
          line-height: 1.6;
        }
        .tiny {
          font-size: 11px;
          margin-top: 8px;
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
          margin-top: 8px;
        }
        .btn.ghost {
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text-dim);
        }
        .btn.ghost:hover:not(:disabled) {
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
        .progress {
          height: 4px;
          background: var(--bg);
          border-radius: 2px;
          margin-top: 8px;
          overflow: hidden;
        }
        .progress-bar {
          height: 100%;
          background: var(--accent);
          transition: width 0.15s linear;
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
