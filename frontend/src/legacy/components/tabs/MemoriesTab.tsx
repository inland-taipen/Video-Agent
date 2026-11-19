// src/legacy/components/tabs/MemoriesTab.tsx — browse and search extracted memories.
import React, { useEffect, useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import { api, Memory, Persona } from '../../api';
import { go } from '../../nav';
import { ErrorNote, OriginalClip, Spinner } from '../common';

export function MemoriesTab({ persona }: { persona: Persona }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Memory[] | null>(null);
  const [error, setError] = useState('');
  const canEdit = persona.role !== 'listener';

  const load = (query: string, signal?: { cancelled: boolean }) => {
    setError('');
    api.memories(persona.id, query.trim() || undefined)
      .then((m) => { if (!signal?.cancelled) setItems(m); })
      .catch((e) => { if (!signal?.cancelled) setError(e.message); });
  };

  useEffect(() => {
    const s = { cancelled: false };
    const t = window.setTimeout(() => load(q, s), q ? 350 : 0);
    return () => { s.cancelled = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, persona.id]);

  return (
    <div>
      <div className="lg-searchbar">
        <Search size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories — try a name, a place, or “how did they meet”" aria-label="Search memories" />
      </div>

      {!!persona.people?.length && !q && (
        <div className="lg-people">
          <span className="lg-small lg-muted">People in their stories:</span>
          {persona.people.slice(0, 24).map((pp) => (
            <button key={pp.name} className="lg-chip" onClick={() => setQ(pp.name)}>
              {pp.name}{pp.relationship && <span className="lg-muted"> · {pp.relationship}</span>}
            </button>
          ))}
        </div>
      )}

      <ErrorNote message={error} onRetry={() => load(q)} />
      {!items && !error && <Spinner label="Loading memories…" />}
      {items && items.length === 0 && (
        <div className="lg-empty">
          {q ? <p>No memories match “{q}”.</p> : (
            <>
              <h3>No memories yet</h3>
              <p>Memories are created automatically from recordings and written stories.</p>
              {canEdit && <button className="lg-btn lg-btn--primary" onClick={() => go(`/p/${persona.id}/recordings`)}>Add a recording</button>}
            </>
          )}
        </div>
      )}
      <div className="lg-memories">
        {items?.map((m) => <MemoryCard key={m.id} m={m} canEdit={canEdit} searching={!!q} onChanged={() => load(q)} />)}
      </div>
    </div>
  );
}

function MemoryCard({ m, canEdit, searching, onChanged }: { m: Memory; canEdit: boolean; searching: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [summary, setSummary] = useState(m.summary);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    try { await api.updateMemory(m.id, { title, summary }); setEditing(false); onChanged(); } catch (e) { setError((e as Error).message); }
  };
  const remove = async () => {
    try { await api.deleteMemory(m.id); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <article className="lg-card lg-memory">
      {editing ? (
        <div className="lg-form">
          <input className="lg-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea className="lg-input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />
          <div className="lg-actions">
            <button className="lg-btn lg-btn--primary lg-btn--sm" onClick={save}>Save</button>
            <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <header className="lg-memory__head">
            <h3>{m.title}</h3>
            {m.time_period && <span className="lg-pill lg-pill--muted">{m.time_period}</span>}
            {m.source_kind === 'family_account' && <span className="lg-pill lg-pill--warn">told by family</span>}
            {searching && m.relevant === false && <span className="lg-pill lg-pill--muted">weak match</span>}
          </header>
          <p>{m.summary}</p>
          {m.excerpt && <blockquote className="lg-quote">“{m.excerpt}”</blockquote>}
          {m.people && <p className="lg-small lg-muted">With {m.people}</p>}
        </>
      )}
      <footer className="lg-memory__foot">
        <span className="lg-small lg-muted">From “{m.recording_title || 'a recording'}”</span>
        {m.recording_id && <OriginalClip recordingId={m.recording_id} start={m.start_sec} end={m.end_sec} compact />}
        {canEdit && !editing && (
          <span className="lg-actions">
            <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setEditing(true)} aria-label="Edit memory"><Pencil size={14} /></button>
            {confirmDelete ? (
              <>
                <button className="lg-btn lg-btn--danger lg-btn--sm" onClick={remove}>Delete memory</button>
                <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setConfirmDelete(false)}>Keep</button>
              </>
            ) : (
              <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setConfirmDelete(true)} aria-label="Delete memory"><Trash2 size={14} /></button>
            )}
          </span>
        )}
      </footer>
      <ErrorNote message={error} />
    </article>
  );
}
