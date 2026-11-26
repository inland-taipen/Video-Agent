// src/legacy/components/PersonaProfile.tsx — a persona's profile page + tabs.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Phone, Pencil } from 'lucide-react';
import { api, Capabilities, lifeSpan, Persona, User } from '../api';
import { CallScreen } from '../call/CallScreen';
import { go } from '../nav';
import { ErrorNote, Portrait, Spinner } from './common';
import { AboutTab } from './tabs/AboutTab';
import { FamilyTab } from './tabs/FamilyTab';
import { HistoryTab } from './tabs/HistoryTab';
import { LifeStoryTab } from './tabs/LifeStoryTab';
import { MemoriesTab } from './tabs/MemoriesTab';
import { RecordingsTab } from './tabs/RecordingsTab';

const TABS: [string, string][] = [
  ['memories', 'Memories'], ['recordings', 'Recordings'], ['lifestory', 'Life story'], ['family', 'Family access'],
  ['history', 'Past conversations'], ['about', 'Consent & voice'],
];

interface Props { id: string; tab: string; inCall: boolean; caps: Capabilities | null; user: User }

export function PersonaProfile({ id, tab, inCall, caps, user }: Props) {
  const [p, setP] = useState<Persona | null>(null);
  const [error, setError] = useState('');
  const [photoVersion, setPhotoVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError('');
    api.persona(id).then(setP).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error && !p) {
    return <div className="lg-page"><ErrorNote message={error} onRetry={load} /><button className="lg-btn lg-btn--ghost" onClick={() => go('')}>Back</button></div>;
  }
  if (!p) return <div className="lg-page"><Spinner label="Loading…" /></div>;

  const canEdit = p.role !== 'listener';

  if (inCall) {
    return <CallScreen persona={p} caps={caps} onClose={() => { go(`/p/${id}`); load(); }} />;
  }

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      await api.uploadPhoto(p.id, f);
      setP({ ...p, has_photo: true });
      setPhotoVersion((v) => v + 1);
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="lg-page">
      <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => go('')}><ArrowLeft size={16} /> All legacies</button>

      <section className="lg-hero">
        <div className="lg-hero__photo">
          <Portrait persona={p} size={140} version={photoVersion} />
          {canEdit && (
            <>
              <button className="lg-hero__photobtn" onClick={() => fileInput.current?.click()} aria-label="Change photo"><Camera size={16} /></button>
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onPhoto} />
            </>
          )}
        </div>
        <div className="lg-hero__body">
          {p.is_demo && <span className="lg-pill lg-pill--warn">Fictional demo persona</span>}
          {editing ? <EditDetails p={p} onDone={(np) => { if (np) setP({ ...p, ...np }); setEditing(false); }} /> : (
            <>
              <h1 className="lg-title">{p.name}</h1>
              <p className="lg-muted">{lifeSpan(p)}</p>
              {p.bio && <p className="lg-hero__bio">{p.bio}</p>}
              <p className="lg-small lg-muted">
                {p.counts.memories} memories from {p.counts.recordings} recordings · you are {p.my_relationship ? `their ${p.my_relationship}, ` : ''}{p.role}
                {canEdit && <> · <button className="lg-link" onClick={() => setEditing(true)}><Pencil size={12} /> Edit details</button></>}
              </p>
            </>
          )}
          <div className="lg-hero__cta">
            <button className="lg-btn lg-btn--call lg-btn--lg" onClick={() => go(`/p/${p.id}/call`)}>
              <Phone size={20} /> Start voice conversation
            </button>
            <span className="lg-small lg-muted">An AI recreation, built only from recorded memories.</span>
          </div>
        </div>
      </section>

      <ErrorNote message={error} />

      <nav className="lg-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <a key={key} role="tab" aria-selected={tab === key} className={`lg-tab ${tab === key ? 'is-active' : ''}`} href={`#/legacy/p/${p.id}/${key}`}>{label}</a>
        ))}
      </nav>

      <div className="lg-tabpanel" role="tabpanel">
        {tab === 'memories' && <MemoriesTab persona={p} />}
        {tab === 'recordings' && <RecordingsTab persona={p} caps={caps} onChange={load} />}
        {tab === 'lifestory' && <LifeStoryTab persona={p} />}
        {tab === 'family' && <FamilyTab persona={p} user={user} />}
        {tab === 'history' && <HistoryTab persona={p} />}
        {tab === 'about' && <AboutTab persona={p} caps={caps} />}
      </div>
    </div>
  );
}

function EditDetails({ p, onDone }: { p: Persona; onDone: (np: Persona | null) => void }) {
  const [f, setF] = useState({ name: p.name, born: p.born || '', passed: p.passed || '', bio: p.bio });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await api.updatePersona(p.id, { name: f.name, born: f.born || null, passed: f.passed || null, bio: f.bio }));
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="lg-form" onSubmit={save}>
      <label className="lg-field"><span>Name</span><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="lg-row">
        <label className="lg-field"><span>Born</span><input value={f.born} onChange={(e) => setF({ ...f, born: e.target.value })} /></label>
        <label className="lg-field"><span>Passed away</span><input value={f.passed} onChange={(e) => setF({ ...f, passed: e.target.value })} /></label>
      </div>
      <label className="lg-field"><span>Biography</span><textarea rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
      <ErrorNote message={error} />
      <div className="lg-actions">
        <button className="lg-btn lg-btn--primary lg-btn--sm" disabled={busy}>Save</button>
        <button type="button" className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}
