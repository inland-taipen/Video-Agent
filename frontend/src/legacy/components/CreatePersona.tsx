// src/legacy/components/CreatePersona.tsx — create a legacy profile with recorded consent.
import React, { useState } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { api, Capabilities } from '../api';
import { go } from '../nav';
import { ErrorNote } from './common';

export const LANGUAGES: [string, string][] = [
  ['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'Hindi'],
  ['mr-IN', 'Marathi'], ['gu-IN', 'Gujarati'], ['ta-IN', 'Tamil'], ['te-IN', 'Telugu'], ['bn-IN', 'Bengali'],
  ['kn-IN', 'Kannada'], ['ml-IN', 'Malayalam'], ['pa-IN', 'Punjabi'], ['ur-IN', 'Urdu'],
];

export function CreatePersona({ caps }: { caps: Capabilities | null }) {
  const [f, setF] = useState({ name: '', born: '', passed: '', bio: '', language: 'en-IN', relationship: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const p = await api.createPersona({ ...f, born: f.born || undefined, passed: f.passed || undefined, consent_accepted: consent });
      go(`/p/${p.id}/recordings`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="lg-page lg-page--narrow">
      <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => go('')}><ArrowLeft size={16} /> All legacies</button>
      <h1 className="lg-title">Create a digital legacy</h1>
      <p className="lg-lead">Start with the basics. You’ll add recordings on the next screen.</p>
      <form className="lg-card lg-form" onSubmit={submit}>
        <label className="lg-field"><span>Their full name</span>
          <input required value={f.name} onChange={set('name')} placeholder="e.g. Ramesh Kulkarni" />
        </label>
        <div className="lg-row">
          <label className="lg-field"><span>Born (optional)</span><input value={f.born} onChange={set('born')} placeholder="1948" /></label>
          <label className="lg-field"><span>Passed away (optional)</span><input value={f.passed} onChange={set('passed')} placeholder="2021" /></label>
        </div>
        <label className="lg-field"><span>Language they spoke in recordings</span>
          <select value={f.language} onChange={set('language')}>
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="lg-field"><span>Short biography</span>
          <textarea rows={4} value={f.bio} onChange={set('bio')} placeholder="Where they grew up, what they did, what they loved…" />
          <small className="lg-muted">The AI may use this as background, but it will only tell stories that come from recordings.</small>
        </label>
        <label className="lg-field"><span>Your relationship to them</span>
          <input required value={f.relationship} onChange={set('relationship')} placeholder="e.g. son, granddaughter" />
        </label>

        <div className="lg-consent">
          <p className="lg-consent__head"><ShieldCheck size={18} /> Consent and authorisation</p>
          <p className="lg-small">{caps?.consent_text.persona || 'Loading consent statement…'}</p>
          <label className="lg-check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
            <span>I confirm the statement above. My name, the date, and this statement will be recorded.</span>
          </label>
        </div>

        <ErrorNote message={error} />
        <button className="lg-btn lg-btn--primary" disabled={busy || !consent || !caps}>{busy ? 'Creating…' : 'Create legacy'}</button>
      </form>
    </div>
  );
}
