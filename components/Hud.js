"use client";

import { useState } from "react";
import Calibrator from "./Calibrator";
import VideoFrames from "./VideoFrames";

// Pestañas del HUD — la primera es la activa por defecto.
// El `sub` se muestra en la cabecera como subtítulo de la marca.
const TABS = [
  {
    id: "calibrator",
    label: "Calibrador",
    sub: "Calibrador de cancha · CLARA",
  },
  {
    id: "video",
    label: "Video / Frames",
    sub: "Extractor de frames · CLARA",
  },
];

export default function Hud() {
  const [tab, setTab] = useState(TABS[0].id);
  // Frame que el extractor de video manda al calibrador.
  const [pendingFrame, setPendingFrame] = useState(null);

  const active = TABS.find((t) => t.id === tab) || TABS[0];

  const handleUseFrame = (file) => {
    setPendingFrame(file);
    setTab("calibrator");
  };

  return (
    <div className="hud">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">MIRA</span>
          <span className="brand-sep">/</span>
          <span className="brand-sub">{active.sub}</span>
        </div>
        <span className="brand-ver">v0.2 — Fase 1</span>
      </header>

      <nav className="navbar" aria-label="Navegación principal">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={"nav-btn" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="body">
        {tab === "calibrator" && (
          <Calibrator
            embedded
            initialFrame={pendingFrame}
            onFrameConsumed={() => setPendingFrame(null)}
          />
        )}
        {tab === "video" && <VideoFrames onUseFrame={handleUseFrame} />}
      </div>

      <style jsx>{`
        .hud {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
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
        .navbar {
          display: flex;
          gap: 4px;
          padding: 0 16px;
          background: var(--bg-elev);
          border-bottom: 1px solid var(--border);
        }
        .nav-btn {
          padding: 10px 16px;
          font-size: 12px;
          color: var(--text-dim);
          font-family: var(--sans);
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.15s, border-color 0.15s;
        }
        .nav-btn:hover {
          color: var(--text);
        }
        .nav-btn.active {
          color: var(--accent);
          border-bottom-color: var(--accent);
        }
        .body {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
      `}</style>
    </div>
  );
}
