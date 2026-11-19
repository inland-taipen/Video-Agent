// src/legacy/components/common.tsx — small shared pieces.
import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pause, Play } from 'lucide-react';
import { fetchBlobUrl, fmtTime, Persona } from '../api';

/** Loads an authenticated file as an object URL; revokes it on unmount. */
export function useAuthedUrl(path: string | null): { url: string | null; error: string } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path) { setUrl(null); return; }
    const ctrl = new AbortController();
    let made: string | null = null;
    fetchBlobUrl(path, ctrl.signal)
      .then((u) => { made = u; setUrl(u); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => { ctrl.abort(); if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return { url, error };
}

export function initials(name: string) {
  return name.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');
}

export function Portrait({ persona, size = 96, version = 0 }: { persona: Pick<Persona, 'id' | 'name' | 'has_photo'>; size?: number; version?: number }) {
  const { url } = useAuthedUrl(persona.has_photo ? `/personas/${persona.id}/photo?v=${version}` : null);
  return (
    <div className="lg-portrait" style={{ width: size, height: size, fontSize: size * 0.34 }}>
      {url ? <img src={url} alt={`Photo of ${persona.name}`} /> : <span aria-hidden="true">{initials(persona.name)}</span>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="lg-spinner" role="status"><LoaderCircle size={16} className="lg-spin" />{label && <span>{label}</span>}</span>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="lg-alert lg-alert--error" role="alert">
      <span>{message}</span>
      {onRetry && <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/**
 * Plays the ORIGINAL uploaded recording (optionally from a timestamp). Labelled
 * clearly so it can never be confused with the AI voice.
 */
export function OriginalClip({ recordingId, start, end, compact }: { recordingId: string; start?: number | null; end?: number | null; compact?: boolean }) {
  const [load, setLoad] = useState(false);
  const { url, error } = useAuthedUrl(load ? `/recordings/${recordingId}/audio` : null);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const a = audio.current;
    if (!a || !url) return;
    a.currentTime = start ?? 0;
    a.play().catch(() => undefined);
  }, [url, start]);

  const toggle = () => {
    if (!load) { setLoad(true); return; }
    const a = audio.current;
    if (!a) return;
    if (a.paused) { if (start != null && end != null && (a.currentTime < start || a.currentTime >= end)) a.currentTime = start; a.play(); }
    else a.pause();
  };

  return (
    <span className="lg-clip">
      <button type="button" className="lg-btn lg-btn--ghost lg-btn--sm" onClick={toggle} disabled={load && !url && !error}>
        {load && !url && !error ? <LoaderCircle size={14} className="lg-spin" /> : playing ? <Pause size={14} /> : <Play size={14} />}
        {compact ? 'Original' : 'Play original recording'}{start != null ? ` · ${fmtTime(start)}` : ''}
      </button>
      {error && <span className="lg-muted lg-small">{error}</span>}
      {url && (
        <audio
          ref={audio}
          src={url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => { if (end != null && e.currentTarget.currentTime > end + 1) e.currentTarget.pause(); }}
        />
      )}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    working: ['ok', 'Working'], mock: ['warn', 'Mock fallback'], unavailable: ['err', 'Unavailable'],
    deferred: ['muted', 'Deferred'],
  };
  const [tone, label] = map[status] || ['muted', status];
  return <span className={`lg-pill lg-pill--${tone}`}>{label}</span>;
}
