// src/legacy/LegacyApp.tsx — Digital Legacy section: auth gate + hash routing.
import React, { useCallback, useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { api, Capabilities, getToken, setToken, setUnauthorizedHandler, User } from './api';
import { AuthScreen } from './components/AuthScreen';
import { CreatePersona } from './components/CreatePersona';
import { PersonaList } from './components/PersonaList';
import { PersonaProfile } from './components/PersonaProfile';
import { Spinner } from './components/common';
import { parseRoute, Route } from './nav';
import './legacy.css';

export default function LegacyApp() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    api.capabilities().then(setCaps).catch(() => setCaps(null));
    if (!getToken()) return;
    api.me().then(setUser).catch(() => setToken(null)).finally(() => setChecking(false));
  }, [signOut]);

  if (checking) return <div className="lg lg-center"><Spinner label="Loading…" /></div>;

  if (!user) {
    return (
      <div className="lg">
        <AuthScreen onSignedIn={(token, u) => { setToken(token); setUser(u); }} />
      </div>
    );
  }

  return (
    <div className="lg">
      <div className="lg-userbar">
        <span>Signed in as <strong>{user.name}</strong></span>
        <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => { api.logout().catch(() => undefined); signOut(); }}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
      {route.name === 'home' && <PersonaList caps={caps} />}
      {route.name === 'new' && <CreatePersona caps={caps} />}
      {(route.name === 'persona' || route.name === 'call') && (
        <PersonaProfile key={route.id} id={route.id} tab={route.name === 'persona' ? route.tab : 'memories'} inCall={route.name === 'call'} caps={caps} user={user} />
      )}
    </div>
  );
}
