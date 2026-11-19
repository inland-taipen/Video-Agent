// src/legacy/components/tabs/RecordingsTab.tsx — upload / record / paste stories and watch processing.
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileText, Mic, RefreshCw, Square, Trash2, Upload } from 'lucide-react';
import { api, Capabilities, fmtTime, Persona, Recording } from '../../api';
import { ErrorNote, OriginalClip, Spinner } from '../common';

const PROCESSING = new Set(['queued', 'transcribing', 'extracting', 'embedding']);
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued', transcribing: 'Transcribing', extracting: 'Finding memories', embedding: 'Indexing',
  ready: 'Ready', needs_transcript: 'Needs transcript', failed: 'Failed',
};

export function RecordingsTab({ persona, caps, onChange }: { persona: Persona; caps: Capabilities | null; onChange: () => void }) {
  const [items, setItems] = useState<Recording[] | null>(null);
  const [error, setError] = useState('');
  const canEdit = persona.role !== 'listener';
  const processing = items?.some((r) => PROCESSING.has(r.status));
  const wasProcessing = useRef(false);

  const load = () => api.recordings(persona.id).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [persona.id]);

  useEffect(() => {
    if (!processing) {
      if (wasProcessing.current) onChange(); // refresh counts once processing finishes
      wasProcessing.current = false;
      return;
    }
    wasProcessing.current = true;
    const t = window.setInterval(load, 2500);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing]);

  return (
    <div>
      {canEdit && <AddRecording persona={persona} caps={caps} onAdded={() => { load(); onChange(); }} />}
      <ErrorNote message={error} onRetry={load} />
      {!items && !error && <Spinner label="Loading recordings…" />}
      {items && items.length === 0 && <div className="lg-empty"><p>No recordings yet.</p></div>}
      <div className="lg-list">
        {items?.map((r) => <RecordingItem key={r.id} r={r} canEdit={canEdit} onChanged={() => { load(); onChange(); }} />)}
      </div>
    </div>
  );
}

type Source = 'file' | 'record' | 'text';

function AddRecording({ persona, caps, onAdded }: { persona: Persona; caps: Capabilities | null; onAdded: () => void }) {
  const [source, setSource] = useState<Source>('file');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [recordedOn, setRecordedOn] = useState('');
  const [speaker, setSpeaker] = useState('solo');
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(persona.counts.recordings === 0);

  const reset = () => { setFile(null); setTitle(''); setRecordedOn(''); setNotes(''); setText(''); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const f = new FormData();
    f.append('title', title || file?.name || 'Untitled story');
    f.append('speaker_mode', source === 'text' && speaker !== 'family_account' ? 'transcript' : speaker);
    if (recordedOn) f.append('recorded_on', recordedOn);
    if (notes) f.append('notes', notes);
    if (source === 'text') {
      if (!text.trim()) { setError('Please write or paste the story.'); return; }
      f.append('transcript', text);
    } else {
      if (!file) { setError(source === 'record' ? 'Record something first.' : 'Choose an audio file.'); return; }
      f.append('file', file);
      if (text.trim()) f.append('transcript', text);
    }
    setBusy(true);
    try {
      await api.addRecording(persona.id, f);
      reset();
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button className="lg-btn lg-btn--primary" onClick={() => setOpen(true)}><Upload size={16} /> Add a recording or story</button>;
  }

  return (
    <form className="lg-card lg-form lg-upload" onSubmit={submit}>
      <div className="lg-upload__head">
        <h3>Add to {persona.name.split(' ')[0]}’s archive</h3>
        <button type="button" className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="lg-seg" role="radiogroup" aria-label="Source">
        {([['file', 'Upload audio', Upload], ['record', 'Record now', Mic], ['text', 'Write or paste', FileText]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" role="radio" aria-checked={source === k} className={source === k ? 'is-active' : ''}
            onClick={() => { setSource(k); setFile(null); }}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {source === 'file' && (
        <label className="lg-drop">
          <input type="file" accept="audio/*,video/mp4,video/webm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {file ? <span><strong>{file.name}</strong> · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
            : <span>Choose an audio file (MP3, WAV, M4A, OGG, WebM…). The original is kept unchanged.</span>}
        </label>
      )}
      {source === 'record' && <Recorder onRecorded={setFile} />}

      <div className="lg-row">
        <label className="lg-field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Diwali 1998 interview" /></label>
        <label className="lg-field"><span>When was it recorded? (optional)</span><input value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} placeholder="e.g. 2015" /></label>
      </div>
      <label className="lg-field"><span>Who is speaking?</span>
        <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
          {source === 'text' ? (
            <>
              <option value="solo">Their own words, written down</option>
              <option value="family_account">A family member’s account about them</option>
            </>
          ) : (
            <>
              <option value="solo">Only them</option>
              <option value="interview">An interview — someone asks, they answer</option>
              <option value="family_account">A family member talking about them</option>
            </>
          )}
        </select>
      </label>
      {source === 'text' ? (
        <label className="lg-field"><span>The story</span>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write it as they told it. Separate stories with blank lines." />
        </label>
      ) : (
        <details className="lg-details">
          <summary>Already have a transcript? (optional)</summary>
          <textarea className="lg-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste it here to skip automatic speech-to-text." />
        </details>
      )}
      <label className="lg-field"><span>Notes for the archive (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context that helps — who else is in the recording, where it was made…" />
      </label>
      {source !== 'text' && caps?.speech_to_text.status !== 'working' && (
        <p className="lg-alert lg-alert--warn">Automatic speech-to-text is not configured. The audio will be stored, and you can paste a transcript afterwards.</p>
      )}
      <ErrorNote message={error} />
      <button className="lg-btn lg-btn--primary" disabled={busy}>{busy ? 'Uploading…' : 'Add to archive'}</button>
    </form>
  );
}

function Recorder({ onRecorded }: { onRecorded: (f: File | null) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'done'>('idle');
  const [secs, setSecs] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef(0);

  useEffect(() => () => {
    window.clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const start = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = r.mimeType || 'audio/webm';
        const blob = new Blob(chunks.current, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        onRecorded(new File([blob], `recording-${new Date().toISOString().slice(0, 16).replace(':', '')}.${ext}`, { type: type.split(';')[0] }));
        setUrl(URL.createObjectURL(blob));
        setState('done');
      };
      r.start(1000);
      rec.current = r;
      setSecs(0);
      setState('recording');
      timer.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      setError('Microphone access was blocked. Allow it in the address bar and try again.');
    }
  };
  const stop = () => { window.clearInterval(timer.current); rec.current?.stop(); };
  const redo = () => { onRecorded(null); setUrl(null); setState('idle'); };

  return (
    <div className="lg-recorder">
      {state === 'idle' && <button type="button" className="lg-btn lg-btn--call" onClick={start}><Mic size={16} /> Start recording</button>}
      {state === 'recording' && (
        <>
          <span className="lg-recdot" aria-hidden="true" /> <span>Recording… {fmtTime(secs)}</span>
          <button type="button" className="lg-btn lg-btn--danger" onClick={stop}><Square size={14} /> Stop</button>
        </>
      )}
      {state === 'done' && url && (
        <>
          <audio controls src={url} />
          <button type="button" className="lg-btn lg-btn--ghost lg-btn--sm" onClick={redo}>Record again</button>
        </>
      )}
      <ErrorNote message={error} />
    </div>
  );
}

function RecordingItem({ r, canEdit, onChanged }: { r: Recording; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Recording | null>(null);
  const [transcript, setTranscript] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const busy = PROCESSING.has(r.status);

  useEffect(() => {
    if (open) api.recording(r.id).then(setDetail).catch((e) => setError(e.message));
  }, [open, r.id, r.status]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  const tone = r.status === 'ready' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'needs_transcript' ? 'warn' : 'muted';

  return (
    <article className="lg-card lg-rec">
      <button className="lg-rec__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lg-rec__title">
          <strong>{r.title}</strong>
          <span className="lg-small lg-muted">
            {r.source_type === 'audio' ? `Audio${r.duration_sec ? ` · ${fmtTime(r.duration_sec)}` : ''}` : 'Written story'}
            {r.recorded_on && ` · recorded ${r.recorded_on}`} · added by {r.uploaded_by_name || 'family'}
          </span>
        </span>
        <span className={`lg-pill lg-pill--${tone}`}>{busy && <Spinner />}{STATUS_LABEL[r.status]}</span>
        <ChevronDown size={18} className={open ? 'lg-rot' : ''} />
      </button>
      <p className="lg-small lg-rec__detail">
        {r.status === 'ready' ? `${r.memory_count} memories` : r.status_detail}
        {r.status === 'ready' && r.extraction_source === 'mock' && ' · basic extraction (AI was unavailable — Retry for better results)'}
      </p>

      {r.status === 'needs_transcript' && canEdit && (
        <div className="lg-form">
          <textarea className="lg-input" rows={5} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Paste or type what is said in the recording…" />
          <div className="lg-actions">
            <button className="lg-btn lg-btn--primary lg-btn--sm" disabled={!transcript.trim()} onClick={() => act(() => api.setTranscript(r.id, transcript))}>Use this transcript</button>
            <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => act(() => api.retryRecording(r.id))}><RefreshCw size={14} /> Retry speech-to-text</button>
          </div>
        </div>
      )}

      {open && (
        <div className="lg-rec__body">
          {r.source_type === 'audio' && <OriginalClip recordingId={r.id} />}
          {!detail && <Spinner />}
          {detail?.segments && detail.segments.length > 0 && (
            <details className="lg-details">
              <summary>Transcript ({detail.transcript_source === 'manual' ? 'typed by family' : detail.transcript_source === 'groq-whisper' ? 'automatic — may contain errors' : 'written'})</summary>
              <div className="lg-transcript-text">
                {detail.segments.map((s, i) => (
                  <p key={i}>{s.start_sec != null && <span className="lg-ts">{fmtTime(s.start_sec)}</span>}{s.text}</p>
                ))}
              </div>
            </details>
          )}
          {detail?.memories && detail.memories.length > 0 && (
            <div>
              <p className="lg-small lg-muted">Memories from this recording:</p>
              <ul className="lg-bullets">{detail.memories.map((m) => <li key={m.id}><strong>{m.title}</strong> — {m.summary}</li>)}</ul>
            </div>
          )}
          {canEdit && (
            <div className="lg-actions">
              {!busy && <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => act(() => api.retryRecording(r.id))}><RefreshCw size={14} /> Re-process</button>}
              {confirmDelete ? (
                <>
                  <span className="lg-small">Delete the recording and its {r.memory_count} memories?</span>
                  <button className="lg-btn lg-btn--danger lg-btn--sm" onClick={() => act(() => api.deleteRecording(r.id))}>Delete</button>
                  <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setConfirmDelete(false)}>Keep</button>
                </>
              ) : (
                <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</button>
              )}
            </div>
          )}
        </div>
      )}
      <ErrorNote message={error} />
    </article>
  );
}
