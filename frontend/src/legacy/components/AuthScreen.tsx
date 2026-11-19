// src/legacy/components/AuthScreen.tsx
import React, { useState } from 'react';
import { api, User } from '../api';
import { ErrorNote } from './common';

export function AuthScreen({ onSignedIn }: { onSignedIn: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = mode === 'login' ? await api.login(email, password) : await api.register(email, name, password);
      onSignedIn(res.token, res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lg-auth">
      <div className="lg-auth__intro">
        <p className="lg-eyebrow">Digital Legacy</p>
        <h1 className="lg-title">Keep their stories, and their way of telling them.</h1>
        <p className="lg-lead">
          Turn a loved one’s recorded stories into a private family archive you can talk to by voice.
          Only family members you invite can see recordings, memories, or conversations.
        </p>
      </div>
      <form className="lg-card lg-auth__form" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
        {mode === 'register' && (
          <label className="lg-field"><span>Your name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="lg-field"><span>Email</span>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="lg-field"><span>Password</span>
          <input required type="password" minLength={mode === 'register' ? 8 : undefined} value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        <ErrorNote message={error} />
        <button className="lg-btn lg-btn--primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="lg-small lg-muted">
          {mode === 'login' ? 'New here? ' : 'Already have an account? '}
          <button type="button" className="lg-link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
        {mode === 'register' && <p className="lg-small lg-muted">Invited by family? Use the same email address they invited.</p>}
      </form>
    </div>
  );
}
