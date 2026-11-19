// src/legacy/components/tabs/AboutTab.tsx — consent records, learned style, voice status, deletion.
import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, Capabilities, Persona } from '../../api';
import { go } from '../../nav';
import { ErrorNote, StatusPill } from '../common';

export function AboutTab({ persona, caps }: { persona: Persona; caps: Capabilities | null }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const style = persona.style_profile;
  const hasStyle = !!(style.tone || style.phrases?.length || style.address_terms?.length);

  const del = async () => {
    try { await api.deletePersona(persona.id); go(''); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="lg-stack">
      <section className="lg-card">
        <h3><ShieldCheck size={18} /> Consent records</h3>
        {persona.consents?.length ? (
          <ul className="lg-bullets">
            {persona.consents.map((c, i) => (
              <li key={i}>{c.kind === 'persona_creation' ? 'Creation of this AI recreation' : 'Voice recreation'} — confirmed by {c.given_by} ({c.relationship}) on {new Date(c.accepted_at).toLocaleDateString()}</li>
            ))}
          </ul>
        ) : <p className="lg-muted">No consent records.</p>}
      </section>

      <section className="lg-card">
        <h3>Voice</h3>
        <p>Current voice: <strong>temporary browser voice</strong> <StatusPill status="working" /> — a computer voice, not {persona.name.split(' ')[0]}’s own.</p>
        <p>Recreating their real voice: <StatusPill status="deferred" /></p>
        <p className="lg-small lg-muted">
          Voice cloning needs a paid voice provider (for example ElevenLabs Instant Voice Cloning), clean recordings of only their voice,
          and a separate recorded consent from an authorised family member. The app is ready for it: the voice is a pluggable provider,
          and every reply already records which memories it used.
        </p>
        {caps && <p className="lg-small lg-muted lg-consent-text">Consent that will be required: “{caps.consent_text.voice_clone}”</p>}
      </section>

      <section className="lg-card">
        <h3>How they speak</h3>
        <p className="lg-small lg-muted">Learned from their own recordings and used to shape the AI’s tone.</p>
        {hasStyle ? (
          <>
            {style.tone && <p><strong>Tone:</strong> {style.tone}</p>}
            {!!style.phrases?.length && <p><strong>Phrases they used:</strong> {style.phrases.map((p) => `“${p}”`).join(', ')}</p>}
            {!!style.address_terms?.length && <p><strong>How they addressed people:</strong> {style.address_terms.join(', ')}</p>}
          </>
        ) : <p className="lg-muted">Nothing learned yet. This fills in once recordings are processed by the AI.</p>}
      </section>

      {persona.role === 'owner' && (
        <section className="lg-card lg-danger">
          <h3>Delete this legacy</h3>
          <p className="lg-small">Permanently deletes every recording, memory, and conversation for {persona.name}. This cannot be undone.</p>
          <label className="lg-field"><span>Type <strong>{persona.name}</strong> to confirm</span>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <ErrorNote message={error} />
          <button className="lg-btn lg-btn--danger" disabled={confirm !== persona.name} onClick={del}>Delete permanently</button>
        </section>
      )}
    </div>
  );
}
