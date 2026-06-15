// src/components/ExportPanel.tsx
import React, { useState, useEffect } from 'react';
import { StoryboardFrame, ExportStatus } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';

interface Props {
  frames: StoryboardFrame[];
}

export const ExportPanel: React.FC<Props> = ({ frames }) => {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState('');
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  // Check backend health on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/health`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then(() => setBackendOnline(true))
      .catch(() => setBackendOnline(false));
  }, []);

  // Poll status
  useEffect(() => {
    if (!status || status.status === 'completed' || status.status === 'failed') return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/export/status/${status.task_id}`);
        const data: ExportStatus = await r.json();
        setStatus(data);
        if (data.status === 'completed' || data.status === 'failed') {
          setIsExporting(false);
          clearInterval(id);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, [status]);

  const handleExport = async () => {
    if (!frames.length) return;
    setError('');
    setIsExporting(true);
    setStatus(null);

    try {
      const payload = {
        frames,
        global_seed: frames[0]?.scene.seed ?? 42,
        title: 'My Story',
      };
      const r = await fetch(`${BACKEND_URL}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`Export failed: ${err}`);
      }
      const data: ExportStatus = await r.json();
      setStatus(data);
      if (data.status === 'completed') setIsExporting(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setIsExporting(false);
    }
  };

  const downloadUrl = status?.download_url
    ? `${BACKEND_URL}${status.download_url}`
    : null;

  return (
    <div className="export-panel">
      <h3 className="section-title">📥 Export MP4</h3>

      {backendOnline === false && (
        <div className="alert alert--warn">
          ⚠️ Backend server not detected at <code>{BACKEND_URL}</code>.
          <br />
          Run: <code>cd backend && python3 main.py</code>
        </div>
      )}

      {backendOnline === true && (
        <div className="alert alert--success">✓ Backend online</div>
      )}

      <p className="export-desc">
        Compile all scenes into a single H.264/AAC MP4 with Ken Burns effects and narration audio.
      </p>

      <button
        className="btn-export"
        onClick={handleExport}
        disabled={isExporting || !frames.length || backendOnline === false}
      >
        {isExporting ? (
          <span className="btn-spinner"><span className="spinner" /> Exporting…</span>
        ) : (
          '🎬 Export Video'
        )}
      </button>

      {error && <p className="export-error">❌ {error}</p>}

      {status && (
        <div className="export-status">
          <div className="export-progress-bar">
            <div
              className={`export-progress-fill ${status.status === 'failed' ? 'failed' : ''}`}
              style={{ width: `${status.progress}%` }}
            />
          </div>
          <p className="export-message">
            {status.status === 'failed' ? `❌ ${status.error}` : status.message}
          </p>

          {status.status === 'completed' && downloadUrl && (
            <a href={downloadUrl} download="story_video.mp4" className="btn-download">
              ⬇ Download MP4
            </a>
          )}
        </div>
      )}

      {frames.length > 0 && (
        <div className="export-meta">
          <span>{frames.length} scenes</span>
          <span>{frames.reduce((s, f) => s + (f.scene.duration ?? 3), 0)}s total</span>
          <span>1024×576 · H.264</span>
        </div>
      )}
    </div>
  );
};
