// src/legacy/components/tabs/LifeStoryTab.tsx — guided life-story interview, coverage map and
// biography writer (ported from Bio-per3). Family recordings feed the coverage map; finished
// interview sessions are saved back as recordings so they become memories.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Download, Mic, RefreshCw, Send, Square, Trash2, X } from 'lucide-react';
import {
  api, Biography, CoverageStats, InterviewSession, InterviewTurn, LifeStory, Persona, StoryThread,
} from '../../api';
import { go } from '../../nav';
import { ErrorNote, Spinner } from '../common';

type View = 'interview' | 'coverage' | 'biography' | 'setup';

export function LifeStoryTab({ persona }: { persona: Persona }) {
  const [story, setStory] = useState<LifeStory | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('interview');
  const canEdit = persona.role !== 'listener';

  const load = useCallback(() => {
    api.lifeStory(persona.id).then((s) => { setStory(s); setError(''); }).catch((e) => setError(e.message));
  }, [persona.id]);
  useEffect(load, [load]);

  if (!story) return error ? <ErrorNote message={error} onRetry={load} /> : <Spinner label="Loading life story…" />;

  const views: [View, string][] = [
    ...(canEdit ? [['interview', 'Interview'] as [View, string]] : []),
    ['coverage', 'Coverage & threads'], ['biography', 'Biography'],
    ...(canEdit ? [['setup', 'Interviewer notes'] as [View, string]] : []),
  ];
  const current = views.some(([v]) => v === view) ? view : views[0][0];

  return (
    <div className="lg-stack">
      <CoverageBar stats={story.coverage.stats} sessions={story.sessions.length} threads={story.threads.length} />
      <div className="lg-subtabs" role="tablist">
        {views.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={current === v} className={`lg-chip ${current === v ? 'is-active' : ''}`} onClick={() => setView(v)}>{label}</button>
        ))}
      </div>
      <ErrorNote message={error} />
      {current === 'interview' && <InterviewView persona={persona} story={story} onChange={load} />}
      {current === 'coverage' && <CoverageView story={story} canEdit={canEdit} onChange={load} />}
      {current === 'biography' && <BiographyView persona={persona} initial={story.biography} canEdit={canEdit} />}
      {current === 'setup' && <SetupView persona={persona} story={story} onSaved={load} />}
    </div>
  );
}

function CoverageBar({ stats, sessions, threads }: { stats: CoverageStats; sessions: number; threads: number }) {
  return (
    <div className="lg-card lg-coverage">
      <div className="lg-coverage__head">
        <strong>{stats.percent}% of the life story covered</strong>
        <span className="lg-small lg-muted">
          {stats.covered} covered · {stats.partial} touched · {stats.untouched} still to explore · {sessions} interview {sessions === 1 ? 'session' : 'sessions'} · {threads} open {threads === 1 ? 'thread' : 'threads'}
        </span>
      </div>
      <div className="lg-progress" role="progressbar" aria-valuenow={stats.percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${(stats.covered / stats.total) * 100}%` }} />
        <span className="is-partial" style={{ width: `${(stats.partial / stats.total) * 100}%` }} />
      </div>
    </div>
  );
}

// ── Interview ───────────────────────────────────────────────────────────────

function InterviewView({ persona, story, onChange }: { persona: Persona; story: LifeStory; onChange: () => void }) {
  const first = persona.name.split(' ')[0];
  const [speaker, setSpeaker] = useState<'subject' | 'family'>(story.default_speaker);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const unfinished = story.sessions.find((s) => s.mine && !s.ended_at);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [turns.length, busy]);

  const start = async (sp: 'subject' | 'family') => {
    setBusy(true); setError(''); setSaved(null);
    try {
      const r = await api.startInterview(persona.id, sp);
      setSession(r.session); setTurns(r.session.turns || []); setFallback(false);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg || !session || busy) return;
    setBusy(true); setError('');
    const optimistic: InterviewTurn = { id: `tmp-${Date.now()}`, role: 'user', content: msg, question_id: null, move_type: null, created_at: '' };
    setTurns((t) => [...t, optimistic]); setText('');
    try {
      const r = await api.answerInterview(session.id, msg);
      setTurns((t) => [...t, { id: `a-${Date.now()}`, role: 'agent', content: r.message, question_id: r.question_id, move_type: r.move_type, created_at: '' }]);
      setFallback(r.provider === 'mock');
    } catch (e) {
      setTurns((t) => t.filter((x) => x.id !== optimistic.id)); setText(msg);
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const end = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const r = await api.endInterview(session.id);
      setSaved(r.recording_id || '');
      setSession(null); setTurns([]); onChange();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const dictation = useDictation((blob) => api.stt(blob, persona.language), (t) => setText((cur) => (cur ? `${cur} ${t}` : t)), setError);

  if (!session) {
    return (
      <div className="lg-stack">
        {saved !== null && (
          <div className="lg-alert lg-alert--ok" role="status">
            {saved ? <>Interview saved. It's being turned into memories that {first}'s voice conversation can use — see <button className="lg-link" onClick={() => go(`/p/${persona.id}/recordings`)}>Recordings</button>.</>
              : 'Session closed. Nothing was answered, so nothing was saved.'}
          </div>
        )}
        <div className="lg-card lg-stack">
          <h3>A guided life-story interview</h3>
          <p className="lg-muted">
            An AI interviewer works through 80 questions across five chapters of a life — asking one question at a time,
            going deeper before moving on, and skipping anything the family has already recorded.
          </p>
          <fieldset className="lg-seg-choice">
            <legend className="lg-small lg-muted">Who is answering?</legend>
            <label className="lg-check"><input type="radio" checked={speaker === 'subject'} onChange={() => setSpeaker('subject')} /> {first} (in their own words)</label>
            <label className="lg-check"><input type="radio" checked={speaker === 'family'} onChange={() => setSpeaker('family')} /> Me — sharing my memories of {first}</label>
          </fieldset>
          <div className="lg-actions">
            <button className="lg-btn lg-btn--primary" disabled={busy} onClick={() => start(speaker)}>
              {busy ? <Spinner /> : unfinished && unfinished.speaker === speaker ? 'Continue interview' : 'Start interview'}
            </button>
          </div>
          <ErrorNote message={error} />
        </div>
        {story.sessions.length > 0 && (
          <div>
            <h3 className="lg-small lg-muted">Past sessions</h3>
            <ul className="lg-list">
              {story.sessions.map((s) => (
                <li key={s.id} className="lg-card lg-session">
                  <strong>Session {s.session_number}</strong>
                  <span className="lg-small lg-muted">
                    {s.speaker === 'subject' ? `${first} answering` : `${s.user_name} sharing memories`} · {s.answers} answers · {new Date(s.started_at).toLocaleDateString()}
                  </span>
                  {s.ended_at ? (s.recording_id ? <span className="lg-pill lg-pill--ok">Saved to memories</span> : <span className="lg-pill lg-pill--muted">Empty</span>)
                    : <span className="lg-pill lg-pill--warn">In progress</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="lg-card lg-interview">
      <div className="lg-interview__head">
        <span className="lg-small lg-muted">
          Session {session.session_number} · {session.speaker === 'subject' ? `${first} answering` : `sharing memories of ${first}`}
          {fallback && <span className="lg-pill lg-pill--warn" style={{ marginLeft: 8 }}>Offline fallback — AI unavailable</span>}
        </span>
        <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={end} disabled={busy}><Check size={14} /> End &amp; save to memories</button>
      </div>
      <div className="lg-interview__log" aria-live="polite">
        {turns.map((t) => (
          <div key={t.id} className={`lg-iturn lg-iturn--${t.role}`}>
            <span className="lg-turn__who">{t.role === 'agent' ? 'Interviewer (AI)' : session.speaker === 'subject' ? first : 'You'}</span>
            {t.content.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
          </div>
        ))}
        {busy && <Spinner label="Listening…" />}
        <div ref={endRef} />
      </div>
      <ErrorNote message={error} />
      <div className="lg-interview__compose">
        <textarea
          rows={3} value={text} placeholder="Take your time. Tell it as a story…" aria-label="Your answer"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        />
        <div className="lg-actions">
          <button className={`lg-btn lg-btn--ghost ${dictation.recording ? 'is-recording' : ''}`} onClick={dictation.toggle} disabled={dictation.transcribing || busy}
                  aria-label={dictation.recording ? 'Stop dictation' : 'Dictate answer'}>
            {dictation.transcribing ? <Spinner label="Transcribing…" /> : dictation.recording ? <><Square size={14} /> Stop</> : <><Mic size={16} /> Speak</>}
          </button>
          <button className="lg-btn lg-btn--primary" onClick={send} disabled={busy || !text.trim()}><Send size={16} /> Send</button>
        </div>
        <span className="lg-small lg-muted">Ctrl/⌘ + Enter to send. Answers are saved as you go; “End &amp; save” turns this session into memories.</span>
      </div>
    </div>
  );
}

/** Record one spoken answer and transcribe it on the server (Whisper). */
export function useDictation(transcribe: (b: Blob) => Promise<{ text: string }>, onText: (t: string) => void, onError: (m: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const toggle = async () => {
    if (recording) { rec.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false); setTranscribing(true);
        try {
          const { text } = await transcribe(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }));
          if (text.trim()) onText(text.trim()); else onError("Didn't catch that — try again a little closer to the mic.");
        } catch (e) { onError((e as Error).message); }
        setTranscribing(false);
      };
      r.start(1000);
      rec.current = r;
      setRecording(true);
    } catch {
      onError('Microphone access was blocked. Allow it in the address bar and try again.');
    }
  };
  return { recording, transcribing, toggle };
}

// ── Coverage + threads ──────────────────────────────────────────────────────

function CoverageView({ story, canEdit, onChange }: { story: LifeStory; canEdit: boolean; onChange: () => void }) {
  const [error, setError] = useState('');
  const setThread = async (t: StoryThread, status: 'explored' | 'dismissed') => {
    try { await api.setThread(t.id, status); onChange(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="lg-two">
      <div className="lg-stack">
        {story.coverage.sections.map((sec) => {
          const done = sec.questions.filter((q) => q.status !== 'untouched').length;
          return (
            <details key={sec.id} className="lg-card lg-details" open={sec.id === 1}>
              <summary><strong>{sec.name}</strong> <span className="lg-small lg-muted">· {done}/{sec.questions.length}</span></summary>
              <ul className="lg-qlist">
                {sec.questions.map((q) => (
                  <li key={q.id} className={`lg-q lg-q--${q.status}`}>
                    <span className="lg-q__dot" aria-label={q.status} />
                    <span>{q.skeleton}</span>
                    {q.source === 'recording' && <span className="lg-pill lg-pill--muted">from a recording</span>}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
      <div className="lg-stack">
        <h3>Open threads</h3>
        <p className="lg-small lg-muted">People, events and feelings mentioned in interviews or family recordings that deserve a deeper conversation. The interviewer returns to these.</p>
        <ErrorNote message={error} />
        {story.threads.length === 0 && <p className="lg-muted">None yet.</p>}
        <ul className="lg-list">
          {story.threads.map((t) => (
            <li key={t.id} className="lg-card lg-thread">
              <p>{t.text}</p>
              <span className="lg-small lg-muted">
                {t.sensitivity === 'sensitive' && <span className="lg-pill lg-pill--warn">Sensitive — asked gently, once</span>}
                {t.recording_title ? `From “${t.recording_title}”` : 'From the interview'}
              </span>
              {canEdit && (
                <span className="lg-actions">
                  <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setThread(t, 'explored')}><Check size={14} /> Explored</button>
                  <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setThread(t, 'dismissed')}><X size={14} /> Dismiss</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Biography ───────────────────────────────────────────────────────────────

function BiographyView({ persona, initial, canEdit }: { persona: Persona; initial: Biography | null; canEdit: boolean }) {
  const [bio, setBio] = useState<Biography | null>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bio?.status !== 'generating') return;
    const t = window.setInterval(() => {
      api.biography(persona.id).then((b) => { if (b.status !== 'generating') setBio(b); }).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [bio?.status, persona.id]);

  const generate = async () => {
    setBusy(true); setError('');
    try { setBio(await api.generateBiography(persona.id)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!bio) return;
    try { await api.deleteBiography(bio.id); setBio(null); } catch (e) { setError((e as Error).message); }
  };
  const download = () => {
    if (!bio) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bio.content_md], { type: 'text/markdown' }));
    a.download = `${persona.name.replace(/[^\w]+/g, '-')}-biography.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!bio || bio.status === 'failed') {
    return (
      <div className="lg-empty">
        <BookOpen size={32} />
        <h3>{bio?.status === 'failed' ? "The biography couldn't be written" : 'No biography yet'}</h3>
        {bio?.status === 'failed' ? <p>{bio.status_detail}</p>
          : <p>The writer drafts a literary biography from every interview session and every memory the family has added — family accounts are attributed, never presented as {persona.name.split(' ')[0]}'s own words.</p>}
        <ErrorNote message={error} />
        {canEdit && <button className="lg-btn lg-btn--primary" onClick={generate} disabled={busy}>{busy ? <Spinner /> : 'Write the biography'}</button>}
      </div>
    );
  }
  if (bio.status === 'generating') {
    return <div className="lg-empty"><Spinner label={bio.status_detail || 'Writing…'} /></div>;
  }
  return (
    <div className="lg-stack">
      <div className="lg-actions">
        <span className="lg-small lg-muted">Drafted by AI{bio.generated_by_name ? ` for ${bio.generated_by_name}` : ''} on {new Date(bio.created_at).toLocaleString()} — check facts before sharing.</span>
        <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={download}><Download size={14} /> Download</button>
        {canEdit && <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={generate} disabled={busy}><RefreshCw size={14} /> Rewrite</button>}
        {canEdit && <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={remove}><Trash2 size={14} /> Delete</button>}
      </div>
      <ErrorNote message={error} />
      <article className="lg-card lg-biography"><Markdown text={bio.content_md} /></article>
    </div>
  );
}

/** Minimal, safe Markdown → React (headings, quotes, lists, rules, **bold**, *italic*). */
export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    para = []; list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!line) { flush(); continue; }
    if (h) { flush(); const L = Math.min(h[1].length + 1, 4); blocks.push(React.createElement(`h${L}`, { key: blocks.length }, inline(h[2]))); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { flush(); blocks.push(<hr key={blocks.length} />); continue; }
    if (line.startsWith('>')) { flush(); blocks.push(<blockquote key={blocks.length} className="lg-quote">{inline(line.replace(/^>\s?/, ''))}</blockquote>); continue; }
    if (/^[-*]\s+/.test(line)) { if (para.length) { const p = para; para = []; blocks.push(<p key={blocks.length}>{inline(p.join(' '))}</p>); } list.push(line.replace(/^[-*]\s+/, '')); continue; }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return <>{blocks}</>;
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g).filter(Boolean).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^(\*[^*]+\*|_[^_]+_)$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

// ── Interviewer notes (what Bio-per3 kept in subject.config.js) ──────────────

function SetupView({ persona, story, onSaved }: { persona: Persona; story: LifeStory; onSaved: () => void }) {
  const [f, setF] = useState({ background: story.background, reference_material: story.reference_material });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setMsg('');
    try { await api.updateLifeStory(persona.id, f); setMsg('Saved. The interviewer will use this from the next question.'); onSaved(); }
    catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  return (
    <div className="lg-stack">
    {persona.role === 'owner' && <StoryLinkCard persona={persona} />}
    <form className="lg-form lg-card" onSubmit={save}>
      <p className="lg-muted">Help the interviewer sound informed. It will never ask about what's written here — it uses it to ask better questions.</p>
      <label className="lg-field"><span>Known background</span>
        <textarea rows={8} value={f.background} placeholder="Facts you already know: family, education, work, roles, causes, passions…" onChange={(e) => setF({ ...f, background: e.target.value })} />
      </label>
      <label className="lg-field"><span>Reference material</span>
        <textarea rows={8} value={f.reference_material} placeholder="Public record, articles, documented work — the interviewer treats these as places where the richest stories live, and invites them to be told first-hand." onChange={(e) => setF({ ...f, reference_material: e.target.value })} />
      </label>
      {msg && <div className="lg-alert lg-alert--ok">{msg}</div>}
      <ErrorNote message={error} />
      <div className="lg-actions"><button className="lg-btn lg-btn--primary" disabled={busy}>Save notes</button></div>
    </form>
    </div>
  );
}

/** Owner-only: the one private link that opens this person's own interview page, no account needed. */
function StoryLinkCard({ persona }: { persona: Persona }) {
  const [status, setStatus] = useState<{ active: boolean; created_at: string | null } | null>(null);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const first = persona.name.split(' ')[0];
  useEffect(() => { api.storyLink(persona.id).then(setStatus).catch((e) => setError(e.message)); }, [persona.id]);

  const create = async () => {
    if (status?.active && !window.confirm(`Make a new link? The current link for ${first} will stop working.`)) return;
    try {
      const r = await api.createStoryLink(persona.id);
      setUrl(`${window.location.origin}${window.location.pathname}#/story/${r.token}`);
      setStatus({ active: true, created_at: r.created_at }); setCopied(false);
    } catch (e) { setError((e as Error).message); }
  };
  const revoke = async () => {
    if (!window.confirm(`Turn off ${first}'s link? It will stop working immediately.`)) return;
    try { await api.revokeStoryLink(persona.id); setStatus({ active: false, created_at: null }); setUrl(''); } catch (e) { setError((e as Error).message); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* select manually */ } };

  return (
    <div className="lg-card lg-stack">
      <h3>{first}'s private link</h3>
      <p className="lg-muted lg-small">
        One link, just for {first}: it opens their own page with their portrait and the life-story interview — no account or password.
        It can't see the family's memories or recordings. Anyone with the link can answer as {first}, so send it only to them.
      </p>
      {url ? (
        <>
          <div className="lg-row"><input className="lg-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Private link" />
            <button className="lg-btn lg-btn--primary lg-btn--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
          <p className="lg-small lg-muted">Copy it now — for privacy it's shown only once. You can always make a new one.</p>
        </>
      ) : status?.active ? (
        <p className="lg-small">A link is active (made {new Date(status.created_at || '').toLocaleDateString()}). Lost it? Make a new one — the old one stops working.</p>
      ) : null}
      <ErrorNote message={error} />
      <div className="lg-actions">
        <button className="lg-btn lg-btn--primary lg-btn--sm" onClick={create} disabled={!status}>{status?.active ? 'Make a new link' : 'Create link'}</button>
        {status?.active && <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={revoke}>Turn off link</button>}
      </div>
    </div>
  );
}
