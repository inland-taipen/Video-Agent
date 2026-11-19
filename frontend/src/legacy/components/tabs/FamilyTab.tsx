// src/legacy/components/tabs/FamilyTab.tsx — who can access this legacy.
import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api, Member, Persona, Role, User } from '../../api';
import { ErrorNote, Spinner } from '../common';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including inviting family and deleting the legacy',
  editor: 'Add recordings and edit memories, and talk',
  listener: 'View memories, listen to recordings, and talk',
};

export function FamilyTab({ persona, user }: { persona: Persona; user: User }) {
  const [items, setItems] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('listener');
  const [relationship, setRelationship] = useState('');
  const [info, setInfo] = useState('');
  const isOwner = persona.role === 'owner';

  const load = () => api.members(persona.id).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [persona.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api.addMember(persona.id, { email, role, relationship });
      setInfo(r.joined ? `${email} now has access.` : `${email} will get access as soon as they create an account with that email address.`);
      setEmail(''); setRelationship('');
    });
  };

  return (
    <div className="lg-two">
      <div>
        <h3>People with access</h3>
        <ErrorNote message={error} />
        {!items && <Spinner />}
        <ul className="lg-members">
          {items?.map((m, i) => (
            <li key={m.email || i} className="lg-card lg-member">
              <div>
                <strong>{m.name || m.email}</strong>{m.email && m.email === user.email && <span className="lg-muted"> (you)</span>}
                <div className="lg-small lg-muted">
                  {m.relationship && `${m.relationship} · `}{m.joined ? 'joined' : 'invited — not signed up yet'}
                  {isOwner && m.name && m.email && ` · ${m.email}`}
                </div>
              </div>
              {isOwner && m.email && m.email !== user.email ? (
                <span className="lg-actions">
                  <select value={m.role} onChange={(e) => act(() => api.changeMember(persona.id, m.email!, e.target.value as Role))} aria-label="Role">
                    <option value="listener">Listener</option><option value="editor">Editor</option><option value="owner">Owner</option>
                  </select>
                  <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => act(() => api.removeMember(persona.id, m.email!))}>Remove</button>
                </span>
              ) : <span className="lg-pill lg-pill--muted">{m.role}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        {isOwner ? (
          <form className="lg-card lg-form" onSubmit={invite}>
            <h3><UserPlus size={18} /> Invite a family member</h3>
            <label className="lg-field"><span>Their email</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="lg-field"><span>Their relationship to {persona.name.split(' ')[0]}</span><input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="e.g. grandson" /></label>
            <label className="lg-field"><span>Access</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="listener">Listener</option><option value="editor">Editor</option><option value="owner">Owner</option>
              </select>
              <small className="lg-muted">{ROLE_HELP[role]}</small>
            </label>
            <button className="lg-btn lg-btn--primary">Give access</button>
            {info && <p className="lg-alert lg-alert--ok">{info}</p>}
            <p className="lg-small lg-muted">No email is sent in this prototype — tell them to sign up at this site with that address.</p>
          </form>
        ) : (
          <div className="lg-card"><p>Only owners can invite family members. Your access: <strong>{persona.role}</strong> — {ROLE_HELP[persona.role]}.</p></div>
        )}
        <p className="lg-small lg-muted lg-gap">Each person’s conversations are private to them.</p>
      </div>
    </div>
  );
}
