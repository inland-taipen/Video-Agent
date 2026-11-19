// src/legacy/components/PersonaList.tsx — Digital Legacy home.
import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, Capabilities, lifeSpan, Persona } from '../api';
import { go } from '../nav';
import { ErrorNote, Portrait, Spinner, StatusPill } from './common';

export function PersonaList({ caps }: { caps: Capabilities | null }) {
  const [items, setItems] = useState<Persona[] | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    api.personas().then(setItems).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  return (
    <div className="lg-page">
      <div className="lg-pagehead">
        <div>
          <p className="lg-eyebrow">Digital Legacy</p>
          <h1 className="lg-title">Family voices</h1>
          <p className="lg-lead">Each legacy is a private archive of someone’s recorded stories, which family can talk with by voice.</p>
        </div>
        <button className="lg-btn lg-btn--primary" onClick={() => go('/new')}><Plus size={18} /> Create a legacy</button>
      </div>

      <ErrorNote message={error} onRetry={load} />
      {!items && !error && <Spinner label="Loading…" />}

      {items && items.length === 0 && (
        <div className="lg-empty">
          <h2>No legacies yet</h2>
          <p>Create one for a parent or grandparent, then add their recorded stories. If a relative already made one, ask them to invite your email address.</p>
          <button className="lg-btn lg-btn--primary" onClick={() => go('/new')}><Plus size={18} /> Create a legacy</button>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="lg-grid">
          {items.map((p) => (
            <a key={p.id} className="lg-card lg-personacard" href={`#/legacy/p/${p.id}`}>
              <Portrait persona={p} size={72} />
              <div>
                <h3>{p.name}</h3>
                <p className="lg-muted lg-small">{lifeSpan(p)}</p>
                <p className="lg-small">
                  {p.counts.memories} memories · {p.counts.recordings} recordings
                  {p.counts.processing > 0 && <> · <em>{p.counts.processing} processing</em></>}
                </p>
                <span className="lg-pill lg-pill--muted">{p.role}</span>{p.is_demo && <span className="lg-pill lg-pill--warn">demo</span>}
              </div>
            </a>
          ))}
        </div>
      )}

      {caps && <SystemStatus caps={caps} />}
    </div>
  );
}

export function SystemStatus({ caps }: { caps: Capabilities }) {
  const voice = caps.voices.find((v) => v.name === 'browser');
  const rows: [string, string, string][] = [
    ['Speech-to-text (uploads)', caps.speech_to_text.status, caps.speech_to_text.provider ? 'Groq Whisper' : 'Paste transcripts manually'],
    ['Conversation AI', caps.chat_llm.status, caps.chat_llm.providers.join(' → ') || 'Quotes recordings directly'],
    ['Memory extraction', caps.extraction_llm.providers.length ? 'working' : 'mock', caps.extraction_llm.providers.join(' → ') || 'Simple paragraph splitting'],
    ['Memory search', caps.embeddings.status, caps.embeddings.status === 'working' ? 'Gemini embeddings' : 'Offline keyword vectors'],
    ['Voice', voice?.status || 'working', 'Temporary browser voice'],
    ['Voice cloning', 'deferred', 'Needs a paid provider + consent'],
    ['Storage', 'working', `Local ${caps.database.backend} + files on this server`],
  ];
  return (
    <details className="lg-status">
      <summary>System status</summary>
      <table>
        <tbody>
          {rows.map(([name, status, note]) => (
            <tr key={name}><td>{name}</td><td><StatusPill status={status} /></td><td className="lg-muted">{note}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="lg-small lg-muted">Status shows which keys are configured; a configured key can still be rejected or out of quota, in which case the app falls back automatically.</p>
    </details>
  );
}
