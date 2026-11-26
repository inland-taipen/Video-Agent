// src/legacy/story/StoryPage.tsx — the subject's private page at #/story/<token>.
// One link for one person (Bio-per3's model): portrait + life timeline on the left, the
// life-story interview on the right. No account — the token in the URL is the key, and it
// only reaches this person's interview and finished biography.
import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Mic, Send, Square, X } from 'lucide-react';
import { InterviewSession, InterviewTurn, StoryPageData, storyApi } from '../api';
import { ErrorNote, initials, Spinner } from '../components/common';
import { Markdown, useDictation } from '../components/tabs/LifeStoryTab';
import '../legacy.css';

export default function StoryPage({ token }: { token: string }) {
  const [data, setData] = useState<StoryPageData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [reading, setReading] = useState(false);
  const [done, setDone] = useState(false);

  const load = () => storyApi.page(token).then((d) => {
    setData(d);
    document.title = `${d.page.honorific ? `${d.page.honorific} ` : ''}${d.name} — Life Story`;
  }).catch((e) => setLoadError(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return <div className="lg lg-center st-msg"><div className="lg-card"><h2>Link not available</h2><p className="lg-muted">{loadError}</p></div></div>;
  }
  if (!data) return <div className="lg lg-center"><Spinner label="Opening…" /></div>;

  const fullName = `${data.page.honorific ? `${data.page.honorific} ` : ''}${data.name}`;
  const started = !!data.open_session || data.sessions_done > 0;

  return (
    <div className="lg st">
      <aside className="st-side">
        <div className="st-portrait">
          {data.has_photo ? <img src={storyApi.photoUrl(token)} alt={`Portrait of ${data.name}`} /> : <span>{initials(data.name)}</span>}
        </div>
        <div className="st-nameplate">
          <strong>{data.name}</strong>
          {data.page.nameplate_title && <span>{data.page.nameplate_title}</span>}
        </div>
        {data.page.pull_quote && <blockquote className="st-quote">{data.page.pull_quote}</blockquote>}
        {!!data.page.timeline?.length && (
          <ol className="st-timeline">
            {data.page.timeline.map((t) => <li key={t.year + t.label}><span>{t.year}</span>{t.label}</li>)}
          </ol>
        )}
        <div className="st-progress">
          <span>{data.coverage.percent}% of the story told</span>
          <div className="lg-progress"><span style={{ width: `${(data.coverage.covered / data.coverage.total) * 100}%` }} /><span className="is-partial" style={{ width: `${(data.coverage.partial / data.coverage.total) * 100}%` }} /></div>
        </div>
      </aside>

      <main className="st-main">
        {reading && data.biography ? (
          <div className="lg-stack">
            <button className="lg-btn lg-btn--ghost lg-btn--sm st-back" onClick={() => setReading(false)}><X size={14} /> Close biography</button>
            <article className="lg-card lg-biography"><Markdown text={data.biography.content_md} /></article>
          </div>
        ) : session ? (
          <Interview token={token} session={session} turns={turns} setTurns={setTurns} firstName={data.name.split(' ')[0]}
                     onEnded={() => { setSession(null); setTurns([]); setDone(true); load(); }} />
        ) : (
          <Welcome data={data} fullName={fullName} started={started} done={done} token={token}
                   onStart={(s) => { setSession(s); setTurns(s.turns || []); setDone(false); }}
                   onRead={() => setReading(true)} />
        )}
      </main>
    </div>
  );
}

function Welcome({ data, fullName, started, done, token, onStart, onRead }: {
  data: StoryPageData; fullName: string; started: boolean; done: boolean; token: string;
  onStart: (s: InterviewSession) => void; onRead: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = async () => {
    setBusy(true); setError('');
    try { onStart((await storyApi.start(token)).session); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="st-welcome">
      <p className="lg-eyebrow">A private life-story interview</p>
      <h1 className="st-title">Your life,<br /><em>in your own words.</em></h1>
      <p className="lg-lead">
        Created especially for {fullName}{data.bio ? ` — ${data.bio.charAt(0).toLowerCase()}${data.bio.slice(1)}` : '.'}
      </p>
      {done && <div className="lg-alert lg-alert--ok">Thank you. Today's conversation has been saved for your family. Come back any time to continue.</div>}
      <div className="lg-actions">
        <button className="lg-btn lg-btn--primary lg-btn--lg" onClick={begin} disabled={busy}>
          {busy ? <Spinner /> : data.open_session ? 'Continue where we left off' : started ? 'Begin a new conversation' : 'Begin'}
        </button>
        {data.biography && <button className="lg-btn lg-btn--ghost lg-btn--lg" onClick={onRead}><BookOpen size={18} /> Read your biography</button>}
      </div>
      <ErrorNote message={error} />
      <p className="lg-small lg-muted">
        An AI interviewer will ask one question at a time. Take as long as you like — type or speak your answers, stop whenever you wish,
        and pick up later from this same link. Everything is kept private to you and the family who invited you.
      </p>
      {!!data.page.bio_facts?.length && (
        <div className="st-facts">
          {data.page.bio_facts.map((f) => (
            <div key={f.label} className="lg-card st-fact"><span aria-hidden="true">{f.icon}</span><div><span className="lg-small lg-muted">{f.label}</span><p>{f.value}</p></div></div>
          ))}
        </div>
      )}
    </div>
  );
}

function Interview({ token, session, turns, setTurns, firstName, onEnded }: {
  token: string; session: InterviewSession; turns: InterviewTurn[];
  setTurns: React.Dispatch<React.SetStateAction<InterviewTurn[]>>; firstName: string; onEnded: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [turns.length, busy]);
  const dictation = useDictation((b) => storyApi.stt(token, b), (t) => setText((cur) => (cur ? `${cur} ${t}` : t)), setError);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true); setError('');
    const tmp: InterviewTurn = { id: `u-${Date.now()}`, role: 'user', content: msg, question_id: null, move_type: null, created_at: '' };
    setTurns((t) => [...t, tmp]); setText('');
    try {
      const r = await storyApi.answer(token, session.id, msg);
      setTurns((t) => [...t, { id: `a-${Date.now()}`, role: 'agent', content: r.message, question_id: r.question_id, move_type: r.move_type, created_at: '' }]);
    } catch (e) {
      setTurns((t) => t.filter((x) => x.id !== tmp.id)); setText(msg); setError((e as Error).message);
    }
    setBusy(false);
  };
  const finish = async () => {
    setBusy(true);
    try { await storyApi.end(token, session.id); onEnded(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="lg-interview st-interview">
      <div className="lg-interview__head">
        <span className="lg-small lg-muted">Conversation {session.session_number}</span>
        <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={finish} disabled={busy}><Check size={14} /> Finish for today</button>
      </div>
      <div className="lg-interview__log" aria-live="polite">
        {turns.map((t) => (
          <div key={t.id} className={`lg-iturn lg-iturn--${t.role}`}>
            <span className="lg-turn__who">{t.role === 'agent' ? 'Interviewer' : firstName}</span>
            {t.content.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        ))}
        {busy && <Spinner label="Listening…" />}
        <div ref={endRef} />
      </div>
      <ErrorNote message={error} />
      <div className="lg-interview__compose">
        <textarea rows={4} value={text} placeholder="Take your time. Tell it as a story…" aria-label="Your answer"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="lg-actions">
          <button className={`lg-btn lg-btn--ghost lg-btn--lg ${dictation.recording ? 'is-recording' : ''}`} onClick={dictation.toggle} disabled={dictation.transcribing || busy}>
            {dictation.transcribing ? <Spinner label="Writing it down…" /> : dictation.recording ? <><Square size={16} /> Stop</> : <><Mic size={18} /> Speak your answer</>}
          </button>
          <button className="lg-btn lg-btn--primary lg-btn--lg" onClick={send} disabled={busy || !text.trim()}><Send size={18} /> Send</button>
        </div>
      </div>
    </div>
  );
}
