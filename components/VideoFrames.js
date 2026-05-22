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
  // Refs paralelos al state para que el cleanup al unmount y los chequeos
  // sincrónicos (anti doble-click, cancelación) tengan el valor *actual*
  // sin depender de la closure del render.
  const extractedRef = useRef([]);
  const extractingRef = useRef(false);
  const cancelExtractionRef = useRef(false);

  const [videoName, setVideoName] = useState("");
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [naturalSize, setNaturalSize] = useState([0, 0]);
  const [loadError, setLoadError] = useState("");
  const [playing, setPlaying] = useState(false);
  // true cuando el <video> ya pintó al menos un frame en su buffer. Sin esto
  // drawImage() captura un canvas vacío (negro) y la galería sale en negro.
  const [hasFrame, setHasFrame] = useState(false);

  const [intervalSec, setIntervalSec] = useState(1);
  const [extracted, setExtracted] = useState([]); // [{time, url}]
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);

  // ── Limpieza de URLs ──────────────────────────────────────
  const revokeExtracted = useCallback((list) => {
    list.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  }, []);

  // Mantener `extractedRef` sincronizado para que el cleanup pueda revocar
  // las URLs vigentes al momento del unmount (no las de [] del primer render).
  useEffect(() => {
    extractedRef.current = extracted;
  }, [extracted]);

  // Cleanup al unmount: revocar URLs vivas y cancelar cualquier extracción
  // en curso para que el for-loop no haga setState sobre un componente muerto.
  useEffect(() => {
    return () => {
      cancelExtractionRef.current = true;
      // Resolver cualquier seek pendiente para que el await no quede colgado.
      if (seekResolverRef.current) {
        const r = seekResolverRef.current;
        seekResolverRef.current = null;
        r();
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      revokeExtracted(extractedRef.current);
    };
  }, [revokeExtracted]);

  // ── Carga de archivo ──────────────────────────────────────
  const loadFile = useCallback(
    (file) => {
      if (!file) {
        setLoadError("No se eligió archivo.");
        return;
      }
      // Algunos sistemas/descargas no rellenan file.type. Aceptamos por
      // extensión como fallback para no rechazar videos válidos.
      const isVideoByType = file.type?.startsWith("video/");
      const isVideoByExt = /\.(mp4|webm|mov|m4v|ogg|ogv|mkv|avi)$/i.test(
        file.name || ""
      );
      if (!isVideoByType && !isVideoByExt) {
        setLoadError("El archivo no es un video válido.");
        return;
      }
      setLoadError("");
      // Cancelar extracción en curso (si la hubiera) antes de pisar el video.
      cancelExtractionRef.current = true;
      if (seekResolverRef.current) {
        const r = seekResolverRef.current;
        seekResolverRef.current = null;
        r();
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      // Revocar lo extraído vía ref (no captura stale) y limpiar.
      revokeExtracted(extractedRef.current);
      extractedRef.current = [];
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setVideoName(file.name);
      setExtracted([]);
      setExtractProgress(0);
      setVideoLoaded(false);
      setDuration(0);
      setNaturalSize([0, 0]);
      setCurrentTime(0);
      setPlaying(false);
      setHasFrame(false);
      // El <video> ya está montado; solo cambiamos src.
      if (videoElRef.current) {
        videoElRef.current.pause();
        videoElRef.current.src = url;
        videoElRef.current.load();
      }
    },
    [revokeExtracted]
  );

  const onDrop = (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  };

  // ── Eventos del <video> ───────────────────────────────────
  const onLoadedMetadata = (e) => {
    const v = e.target;
    // Validar que el archivo tenga pista de video. Un mp4 solo-audio reporta
    // videoWidth=0 y drawImage devolvería un canvas vacío sin feedback.
    if (!v.videoWidth || !v.videoHeight) {
      setLoadError("El archivo no tiene pista de video.");
      setVideoLoaded(false);
      return;
    }
    // Algunos webm/mp4 reportan duration=Infinity hasta haberse reproducido.
    // Si no es finita, dejamos 0: el scrubber y el cálculo de "todos los
    // frames" lo tratan como desconocido en vez de propagar NaN.
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    setDuration(d);
    setNaturalSize([v.videoWidth, v.videoHeight]);
    setVideoLoaded(true);
    setCurrentTime(0);
    // Si preload="auto" ya alcanzó readyState>=2, el primer frame está
    // listo — habilitar los botones inmediatamente.
    setHasFrame(v.readyState >= 2);
    // NOTA: el micro-seek para forzar la decodificación del primer frame
    // NO se hace aquí. Se hace en un useEffect después de que React
    // rerenderice y el <video> deje de estar oculto (ver más abajo).
    // Sin esa demora, Edge/Chrome ignoran el seek sobre el elemento oculto
    // y `loadeddata` nunca dispara → botones disabled para siempre.
  };

  // Una vez que videoLoaded=true y el <video> ya está VISIBLE en el DOM,
  // forzar el seek a 0.001 para que el browser decodifique el primer frame.
  // OJO: currentTime=0 es no-op si ya está en 0 — por eso 0.001.
  useEffect(() => {
    if (!videoLoaded) return;
    const v = videoElRef.current;
    if (!v) return;
    if (v.readyState >= 2) {
      setHasFrame(true);
      return;
    }
    // requestAnimationFrame para esperar que el browser haya pintado el
    // layout con el <video> visible antes de pedirle el seek.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        try {
          v.currentTime = 0.001;
        } catch {
          /* el listener canplay cubrirá si esto rebota */
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [videoLoaded]);

  const onLoadedData = (e) => {
    // readyState >= 2 (HAVE_CURRENT_DATA): el frame actual ya está decodificado
    // y drawImage() puede pintarlo.
    if (e.target.readyState >= 2) setHasFrame(true);
  };

  // Fallback: si por codec raro `loadeddata` no dispara, `canplay`
  // (readyState>=3) sí — sin esto los botones quedan disabled para siempre.
  const onCanPlay = (e) => {
    if (e.target.readyState >= 2) setHasFrame(true);
  };

  const onTimeUpdate = (e) => {
    const t = e.target.currentTime;
    setCurrentTime(Number.isFinite(t) ? t : 0);
    if (e.target.readyState >= 2) setHasFrame(true);
  };

  const onSeeked = (e) => {
    if (e?.target?.readyState >= 2) setHasFrame(true);
    // Si hay una extracción de "todos los frames" esperando este seek,
    // la resolvemos.
    if (seekResolverRef.current) {
      const r = seekResolverRef.current;
      seekResolverRef.current = null;
      r();
    }
  };

  // Si la duración era Infinity al loadedmetadata pero el browser termina
  // calculándola después (típico de webm sin index), actualizamos el state
  // para que el scrubber y "Extraer todos" funcionen.
  const onDurationChange = (e) => {
    const v = e.target;
    if (Number.isFinite(v.duration) && v.duration > 0) {
      setDuration(v.duration);
    }
  };

  const onVideoError = () => {
    setLoadError("No se pudo decodificar el video.");
    setVideoLoaded(false);
    setDuration(0);
    setCurrentTime(0);
    setNaturalSize([0, 0]);
    // Si reventó en medio de una extracción, destrabar el await.
    if (seekResolverRef.current) {
      const r = seekResolverRef.current;
      seekResolverRef.current = null;
      r();
    }
    cancelExtractionRef.current = true;
  };

  const onPlay = () => setPlaying(true);
  const onPause = () => setPlaying(false);

  // ── Controles de reproducción ─────────────────────────────
  const togglePlay = () => {
    const v = videoElRef.current;
    if (!v || !videoLoaded) return;
    // v.play() devuelve Promise: si el browser aborta (autoplay policy,
    // seek concurrente, src cambiado), rechaza con AbortError/NotAllowedError.
    // Sin .catch queda como uncaught promise rejection en consola.
    if (v.paused) v.play().catch(() => {});
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
    const w = v.videoWidth || naturalSize[0];
    const h = v.videoHeight || naturalSize[1];
    // Sin dimensiones reales el toBlob saldría vacío y rompería al calibrador
    // con "No se pudo decodificar la imagen".
    if (!w || !h) return null;
    // readyState < 2 = HAVE_CURRENT_DATA aún no listo: drawImage pintaría
    // un canvas vacío (negro). Mejor abortar y dejar que el caller reintente.
    if (v.readyState < 2) return null;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    // Safari puede lanzar InvalidStateError si readyState se degrada entre
    // el chequeo de arriba y el drawImage (purge de buffer por seek
    // concurrente). Devolver null en vez de propagar.
    try {
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
    } catch {
      return null;
    }
    return cv;
  }, [naturalSize]);

  // Espera hasta que el <video> tenga un frame decodificado listo para pintar.
  // Útil cuando el usuario aprieta "Extraer" antes de que cargue el primer
  // frame, o justo después de cambiar de video.
  const waitForFrame = useCallback(
    (timeoutMs = 1500) =>
      new Promise((resolve) => {
        const v = videoElRef.current;
        if (!v) return resolve(false);
        if (v.readyState >= 2) return resolve(true);
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          v.removeEventListener("loadeddata", onReady);
          v.removeEventListener("seeked", onReady);
          v.removeEventListener("canplay", onReady);
          clearTimeout(to);
          resolve(ok);
        };
        const onReady = () => {
          if (v.readyState >= 2) finish(true);
        };
        v.addEventListener("loadeddata", onReady);
        v.addEventListener("seeked", onReady);
        v.addEventListener("canplay", onReady);
        // Pequeño empujón: re-asignar currentTime obliga a decodificar.
        try {
          v.currentTime = v.currentTime || 0;
        } catch {
          /* ignore */
        }
        const to = setTimeout(() => finish(v.readyState >= 2), timeoutMs);
      }),
    []
  );

  const blobFromCanvas = (cv, type = "image/png", quality) =>
    new Promise((resolve) => {
      cv.toBlob((b) => resolve(b), type, quality);
    });

  // ── Extraer el frame visible actual ──────────────────────
  const extractCurrentFrame = async () => {
    if (!videoLoaded) return;
    // Si el usuario aprieta antes de que cargue el primer frame, esperar.
    const ok = await waitForFrame();
    if (!ok) {
      setLoadError("El video aún no decodifica el primer frame. Reintenta.");
      return;
    }
    const cv = drawCurrentToCanvas();
    if (!cv) return;
    const blob = await blobFromCanvas(cv, "image/png");
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const entry = { time: videoElRef.current.currentTime, url };
    setExtracted((prev) => {
      const next = [...prev, entry];
      extractedRef.current = next;
      return next;
    });
  };

  // ── Mandar el frame actual al calibrador ─────────────────
  const sendCurrentToCalibrator = async () => {
    if (!videoLoaded || !onUseFrame) return;
    const ok = await waitForFrame();
    if (!ok) {
      setLoadError("El video aún no decodifica el primer frame. Reintenta.");
      return;
    }
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
    // Guard sincrónico: bloquea doble-click antes de que setExtracting(true)
    // se aplique. Sin esto, dos clicks en el mismo tick entran ambos.
    if (!videoLoaded || extractingRef.current) return;
    const v = videoElRef.current;
    if (!v) return;
    // Sin duración finita no podemos planear el muestreo. El aviso ya está
    // visible en el panel (ver render), así que aquí sólo abortamos.
    if (!Number.isFinite(duration) || duration <= 0) return;
    const step = Math.max(MIN_INTERVAL, Number(intervalSec) || MIN_INTERVAL);
    let count = Math.floor(duration / step) + 1;
    if (count > SAFE_MAX_FRAMES) count = SAFE_MAX_FRAMES;
    if (count <= 0) return;

    extractingRef.current = true;
    cancelExtractionRef.current = false;
    setExtracting(true);
    setExtractProgress(0);
    // Limpiar lo previo (vía ref para no usar closure stale).
    revokeExtracted(extractedRef.current);
    extractedRef.current = [];
    setExtracted([]);
    const out = [];

    const wasPlaying = !v.paused;
    v.pause();

    try {
      for (let i = 0; i < count; i++) {
        if (cancelExtractionRef.current) break;
        const t = Math.min(i * step, duration);
        // Esperar al evento seeked antes de pintar — si no, drawImage
        // saca el frame anterior. El resolver también se llama desde
        // onVideoError y desde el unmount para no quedar colgado.
        await new Promise((resolve) => {
          seekResolverRef.current = resolve;
          v.currentTime = t;
        });
        if (cancelExtractionRef.current) break;
        // Doble guard: si el seek terminó pero readyState aún no llegó,
        // esperar brevemente para no capturar un frame negro.
        if (v.readyState < 2) {
          const ok = await waitForFrame(800);
          if (!ok) continue;
        }
        const cv = drawCurrentToCanvas();
        if (!cv) continue;
        // JPEG en miniaturas para no explotar la memoria.
        const blob = await blobFromCanvas(cv, "image/jpeg", 0.85);
        if (cancelExtractionRef.current) break;
        if (!blob) continue;
        out.push({ time: t, url: URL.createObjectURL(blob) });
        setExtractProgress(Math.round(((i + 1) / count) * 100));
      }
    } finally {
      seekResolverRef.current = null;
      if (cancelExtractionRef.current) {
        // Si nos cancelaron (unmount o nuevo loadFile), descartar lo extraído.
        revokeExtracted(out);
      } else {
        extractedRef.current = out;
        setExtracted(out);
      }
      extractingRef.current = false;
      setExtracting(false);
      if (wasPlaying && !cancelExtractionRef.current) {
        v.play().catch(() => {});
      }
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
    revokeExtracted(extractedRef.current);
    extractedRef.current = [];
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
          {/* El <video> se mantiene siempre montado para que videoElRef no
              cambie entre el estado vacío y el cargado. Si lo desmontamos al
              alternar `videoLoaded`, perdemos el src asignado y el reproductor
              se queda en negro. */}
          <div className={"player-host" + (videoLoaded ? "" : " hidden")}>
            <video
              ref={videoElRef}
              className="video-el"
              // "auto" en lugar de "metadata": necesitamos al menos el primer
              // frame decodificado para que drawImage() no devuelva negro.
              preload="auto"
              // muted permite que el navegador decodifique sin gesto de usuario
              // (Safari/iOS lo exigen) y evita ruido si por error se reproduce.
              muted
              playsInline
              onLoadedMetadata={onLoadedMetadata}
              onLoadedData={onLoadedData}
              onCanPlay={onCanPlay}
              onDurationChange={onDurationChange}
              onTimeUpdate={onTimeUpdate}
              onSeeked={onSeeked}
              onError={onVideoError}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={() => setPlaying(false)}
            />

            {/* Banner de error visible aunque ya haya un video cargado:
                p.ej. "El video aún no decodifica el primer frame" o un
                onError en medio de la extracción. */}
            {videoLoaded && loadError && (
              <div className="vf-error" role="alert">
                {loadError}
                <button
                  className="vf-error-close"
                  onClick={() => setLoadError("")}
                  aria-label="Cerrar mensaje"
                >
                  ×
                </button>
              </div>
            )}

            {videoLoaded && (
              <>
              {/* ── Barra de navegación del video ── */}
              {/* Bloqueada durante extracción: si el usuario mueve el scrubber
                  o usa los botones, el seek dispara onSeeked y resuelve el
                  seekResolverRef con el frame equivocado → la galería queda
                  con frames corruptos. */}
              <div className="navbar" aria-label="Barra de navegación del video">
                <button
                  className="navbtn"
                  onClick={() => seekTo(0)}
                  disabled={extracting}
                  title="Ir al inicio"
                  aria-label="Ir al inicio"
                >
                  ⏮
                </button>
                <button
                  className="navbtn"
                  onClick={() => stepFrame(-1)}
                  disabled={extracting}
                  title="Frame anterior"
                  aria-label="Frame anterior"
                >
                  ◀
                </button>
                <button
                  className="navbtn play"
                  onClick={togglePlay}
                  disabled={extracting}
                  title={playing ? "Pausar" : "Reproducir"}
                  aria-label={playing ? "Pausar" : "Reproducir"}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <button
                  className="navbtn"
                  onClick={() => stepFrame(1)}
                  disabled={extracting}
                  title="Frame siguiente"
                  aria-label="Frame siguiente"
                >
                  ▶
                </button>
                <button
                  className="navbtn"
                  onClick={() => seekTo(duration)}
                  disabled={extracting}
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
                    disabled={extracting}
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
              </>
            )}
          </div>

          {!videoLoaded && (
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
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            // Listar extensiones además de "video/*": algunos sistemas/archivos
            // descargados no exponen MIME, y "video/*" los ocultaría del
            // file picker — solo se podrían cargar con drag-and-drop.
            accept="video/*,.mp4,.webm,.mov,.m4v,.ogg,.ogv,.mkv,.avi"
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
              disabled={!videoLoaded || !hasFrame || extracting}
              onClick={extractCurrentFrame}
            >
              {videoLoaded && !hasFrame
                ? "Cargando frame…"
                : "Extraer este frame"}
            </button>
            <button
              className="btn primary"
              disabled={!videoLoaded || !hasFrame || extracting}
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
            {videoLoaded && duration <= 0 && (
              <p className="warn-msg" role="status">
                El video aún no reporta su duración. Reprodúcelo un instante y
                vuelve a intentar.
              </p>
            )}
            <button
              className="btn ghost"
              disabled={!videoLoaded || extracting || duration <= 0}
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
        .vf-error {
          width: 100%;
          padding: 10px 14px;
          background: rgba(184, 60, 60, 0.12);
          border: 1px solid var(--bad, #b83c3c);
          border-radius: 6px;
          color: var(--text);
          font-size: 12px;
          line-height: 1.5;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .vf-error-close {
          background: none;
          border: none;
          color: var(--text-dim);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 0 4px;
        }
        .vf-error-close:hover {
          color: var(--text);
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
        /* Posicionamiento fuera de pantalla, no display:none. Mantiene el
           video en el layout para que el browser no aplace la decodificación
           del primer frame mientras está oculto. */
        .player-host.hidden {
          position: absolute;
          left: -99999px;
          top: 0;
          width: 1px;
          height: 1px;
          overflow: hidden;
          pointer-events: none;
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
        .warn-msg {
          font-size: 11px;
          line-height: 1.5;
          color: var(--warn);
          margin-top: 8px;
          padding: 8px 10px;
          background: var(--surface);
          border-left: 2px solid var(--warn);
          border-radius: 4px;
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
