// src/legacy/api.ts — typed client for /api/legacy. No API keys ever live here:
// the browser only holds the user's session token.

const BASE = `${import.meta.env.VITE_BACKEND_URL || ''}/api/legacy`;
const TOKEN_KEY = 'legacy.session';

export type Role = 'owner' | 'editor' | 'listener';

export interface User { id: string; email: string; name: string }

export interface StyleProfile { tone?: string; phrases?: string[]; address_terms?: string[]; notes?: string }

export interface Persona {
  id: string; name: string; born: string | null; passed: string | null; bio: string; language: string;
  has_photo: boolean; is_demo: boolean; style_profile: StyleProfile;
  voice_provider: string; voice_config: Record<string, unknown>; role: Role;
  counts: { memories: number; recordings: number; processing: number }; updated_at: string;
  people?: { name: string; relationship: string; mentions: number }[];
  consents?: { kind: string; relationship: string; accepted_at: string; given_by: string }[];
  my_relationship?: string;
}

export type RecordingStatus = 'queued' | 'transcribing' | 'extracting' | 'embedding' | 'ready' | 'needs_transcript' | 'failed';

export interface Recording {
  id: string; persona_id: string; title: string; source_type: 'audio' | 'text'; speaker_mode: string;
  original_filename: string | null; mime_type: string | null; size_bytes: number | null; duration_sec: number | null;
  recorded_on: string | null; notes: string; status: RecordingStatus; status_detail: string;
  transcript_source: string | null; language: string | null; extraction_source: string | null;
  created_at: string; processed_at: string | null; memory_count: number; uploaded_by_name?: string;
  segments?: { start_sec: number | null; end_sec: number | null; text: string }[];
  memories?: Memory[];
}

export interface Memory {
  id: string; recording_id: string | null; recording_title: string | null; title: string; summary: string;
  excerpt: string; start_sec: number | null; end_sec: number | null; time_period: string; places: string[];
  themes: string[]; people: string; source_kind: 'own_words' | 'family_account'; embedding_model: string;
  score?: number | null; relevant?: boolean | null; created_at: string;
}

export interface Member { email: string | null; role: Role; relationship: string; joined: number; name: string | null }

export interface Capabilities {
  speech_to_text: { provider: string | null; status: string };
  chat_llm: { providers: string[]; status: string };
  extraction_llm: { providers: string[] };
  embeddings: { model: string; status: string };
  voices: { name: string; label: string; client_side: boolean; status: string; available: boolean }[];
  storage: { backend: string }; database: { backend: string };
  consent_text: { persona: string; voice_clone: string };
}

export interface ConversationSummary { id: string; started_at: string; ended_at: string | null; turns: number; first_question: string | null }
export interface Turn { id: string; role: 'user' | 'persona'; text: string; source_ids: string[]; grounded: number; provider: string | null; created_at: string }

// ── Life Story (guided interview + biography, ported from Bio-per3) ──────────
export type CoverageStatus = 'untouched' | 'partial' | 'covered';
export interface CoverageStats { covered: number; partial: number; untouched: number; total: number; percent: number }
export interface CoverageSection {
  id: number; name: string;
  questions: { id: number; skeleton: string; weight: string; status: CoverageStatus; source: 'interview' | 'recording' | null }[];
}
export interface StoryThread { id: string; text: string; sensitivity: 'normal' | 'sensitive'; recording_id: string | null; recording_title: string | null; created_at: string }
export interface InterviewTurn { id: string; role: 'agent' | 'user'; content: string; question_id: number | null; move_type: string | null; created_at: string }
export interface InterviewSession {
  id: string; speaker: 'subject' | 'family'; session_number: number; onboarding: number; last_question: number | null;
  recording_id: string | null; started_at: string; ended_at: string | null; user_name: string | null;
  turns?: InterviewTurn[]; answers?: number; mine?: boolean;
}
export interface Biography {
  id: string; status: 'generating' | 'ready' | 'failed'; status_detail: string; content_md: string;
  provider: string | null; created_at: string; generated_by_name: string | null;
}
export interface LifeStory {
  role: Role; background: string; reference_material: string; profile: Record<string, unknown>; onboarding_complete: boolean;
  coverage: { stats: CoverageStats; sections: CoverageSection[] }; threads: StoryThread[];
  sessions: InterviewSession[]; biography: Biography | null; default_speaker: 'subject' | 'family';
}
export interface InterviewReply {
  message: string; question_id: number | null; move_type: string | null; provider: string; onboarding: boolean; coverage: CoverageStats;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

function headers(extra?: HeadersInit): HeadersInit {
  const t = getToken();
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra || {}) };
}

async function fail(res: Response): Promise<never> {
  let msg = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') msg = body.detail;
    else if (Array.isArray(body.detail)) msg = body.detail.map((d: { msg: string }) => d.msg).join('; ');
  } catch { /* not JSON */ }
  if (res.status === 401) onUnauthorized?.();
  throw new ApiError(res.status, msg);
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(body && !isForm ? { 'Content-Type': 'application/json' } : undefined),
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach the server. Is the backend running?');
  }
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

export const api = {
  register: (email: string, name: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/auth/register', { email, name, password }),
  login: (email: string, password: string) => req<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  logout: () => req('POST', '/auth/logout'),
  me: () => req<User>('GET', '/auth/me'),
  capabilities: () => req<Capabilities>('GET', '/capabilities'),

  personas: () => req<Persona[]>('GET', '/personas'),
  persona: (id: string) => req<Persona>('GET', `/personas/${id}`),
  createPersona: (body: { name: string; born?: string; passed?: string; bio: string; language: string; relationship: string; consent_accepted: boolean }) =>
    req<Persona>('POST', '/personas', body),
  updatePersona: (id: string, body: Partial<Pick<Persona, 'name' | 'born' | 'passed' | 'bio' | 'language' | 'voice_config'>>) =>
    req<Persona>('PATCH', `/personas/${id}`, body),
  deletePersona: (id: string) => req('DELETE', `/personas/${id}`),
  uploadPhoto: (id: string, file: File) => { const f = new FormData(); f.append('file', file); return req('POST', `/personas/${id}/photo`, f); },

  recordings: (pid: string) => req<Recording[]>('GET', `/personas/${pid}/recordings`),
  recording: (rid: string) => req<Recording>('GET', `/recordings/${rid}`),
  addRecording: (pid: string, form: FormData) => req<Recording>('POST', `/personas/${pid}/recordings`, form),
  setTranscript: (rid: string, text: string) => req('POST', `/recordings/${rid}/transcript`, { text }),
  retryRecording: (rid: string) => req('POST', `/recordings/${rid}/retry`),
  deleteRecording: (rid: string) => req('DELETE', `/recordings/${rid}`),

  memories: (pid: string, q?: string) => req<Memory[]>('GET', `/personas/${pid}/memories${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  updateMemory: (mid: string, body: { title?: string; summary?: string; time_period?: string }) => req('PATCH', `/memories/${mid}`, body),
  deleteMemory: (mid: string) => req('DELETE', `/memories/${mid}`),

  members: (pid: string) => req<Member[]>('GET', `/personas/${pid}/members`),
  addMember: (pid: string, body: { email: string; role: Role; relationship: string }) => req<{ joined: boolean }>('POST', `/personas/${pid}/members`, body),
  changeMember: (pid: string, email: string, role: Role) => req('PATCH', `/personas/${pid}/members/${encodeURIComponent(email)}`, { role }),
  removeMember: (pid: string, email: string) => req('DELETE', `/personas/${pid}/members/${encodeURIComponent(email)}`),

  startConversation: (pid: string) => req<{ conversation_id: string; greeting: string; voice_provider: string }>('POST', `/personas/${pid}/conversations`),
  endConversation: (cid: string) => req('POST', `/conversations/${cid}/end`),
  conversations: (pid: string) => req<ConversationSummary[]>('GET', `/personas/${pid}/conversations`),
  conversation: (cid: string) => req<{ id: string; turns: Turn[] }>('GET', `/conversations/${cid}`),

  lifeStory: (pid: string) => req<LifeStory>('GET', `/personas/${pid}/lifestory`),
  updateLifeStory: (pid: string, body: { background?: string; reference_material?: string }) => req('PATCH', `/personas/${pid}/lifestory`, body),
  setThread: (tid: string, status: 'open' | 'explored' | 'dismissed') => req('PATCH', `/threads/${tid}`, { status }),
  startInterview: (pid: string, speaker?: 'subject' | 'family') =>
    req<{ session: InterviewSession; resumed: boolean; coverage: CoverageStats }>('POST', `/personas/${pid}/interview/sessions`, { speaker }),
  interviewSession: (sid: string) => req<InterviewSession>('GET', `/interview/sessions/${sid}`),
  answerInterview: (sid: string, text: string) => req<InterviewReply>('POST', `/interview/sessions/${sid}/turns`, { text }),
  endInterview: (sid: string) => req<{ ok: boolean; recording_id: string | null }>('POST', `/interview/sessions/${sid}/end`, {}),
  generateBiography: (pid: string) => req<Biography>('POST', `/personas/${pid}/biography`),
  biography: (pid: string) => req<Biography>('GET', `/personas/${pid}/biography`),
  deleteBiography: (bid: string) => req('DELETE', `/biographies/${bid}`),

  storyLink: (pid: string) => req<{ active: boolean; created_at: string | null }>('GET', `/personas/${pid}/story-link`),
  createStoryLink: (pid: string) => req<{ token: string; created_at: string }>('POST', `/personas/${pid}/story-link`),
  revokeStoryLink: (pid: string) => req('DELETE', `/personas/${pid}/story-link`),

  stt: (blob: Blob, language?: string, signal?: AbortSignal) => {
    const f = new FormData();
    f.append('file', blob, blob.type.includes('ogg') ? 'turn.ogg' : blob.type.includes('mp4') ? 'turn.mp4' : 'turn.webm');
    if (language) f.append('language', language);
    return req<{ text: string }>('POST', '/stt', f, signal);
  },
};

/** Fetch an authenticated binary resource (photo, original audio) as an object URL. */
export async function fetchBlobUrl(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), signal });
  if (!res.ok) await fail(res);
  return URL.createObjectURL(await res.blob());
}

/** POST for server-side voice synthesis (only for non-browser voice providers). */
export async function fetchSpeech(pid: string, text: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`${BASE}/personas/${pid}/speak`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text }), signal,
  });
  if (!res.ok) await fail(res);
  return res.blob();
}

export type ReplyEvent =
  | { type: 'meta'; turn_id: string; grounded: boolean; sources: Memory[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; provider: string }
  | { type: 'error'; message: string };

/** Send a question and stream the persona's reply as NDJSON events. */
export async function* streamReply(cid: string, text: string, signal: AbortSignal): AsyncGenerator<ReplyEvent> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/conversations/${cid}/messages`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text }), signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    throw new ApiError(0, 'Lost connection to the server');
  }
  if (!res.ok || !res.body) await fail(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as ReplyEvent;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as ReplyEvent;
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function lifeSpan(p: Pick<Persona, 'born' | 'passed'>): string {
  if (p.born && p.passed) return `${p.born} – ${p.passed}`;
  if (p.born) return `Born ${p.born}`;
  return p.passed ? `– ${p.passed}` : '';
}

// ── Private story link (no account: the token in the URL is the credential) ──
export interface StoryPageData {
  name: string; born: string | null; passed: string | null; bio: string; has_photo: boolean;
  page: { honorific?: string; pull_quote?: string; nameplate_title?: string;
          timeline?: { year: string; label: string }[]; bio_facts?: { icon: string; label: string; value: string }[] };
  coverage: CoverageStats; sections: { name: string; total: number; covered: number; partial: number }[]; sessions_done: number; open_session: InterviewSession | null;
  biography: { content_md: string; created_at: string } | null;
}

async function storyReq<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${BASE}/story/${encodeURIComponent(token)}${path}`, {
      method, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const b = await res.json(); if (typeof b.detail === 'string') msg = b.detail; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface SharedItem {
  id: string; title: string; source_type: 'audio' | 'text'; status: RecordingStatus; status_detail: string;
  created_at: string; memory_count: number;
}

export const storyApi = {
  page: (t: string) => storyReq<StoryPageData>(t, 'GET', ''),
  photoUrl: (t: string) => `${BASE}/story/${encodeURIComponent(t)}/photo`,
  start: (t: string) => storyReq<{ session: InterviewSession; resumed: boolean; coverage: CoverageStats }>(t, 'POST', '/sessions'),
  answer: (t: string, sid: string, text: string) => storyReq<InterviewReply>(t, 'POST', `/sessions/${sid}/turns`, { text }),
  end: (t: string, sid: string) => storyReq<{ ok: boolean; recording_id: string | null }>(t, 'POST', `/sessions/${sid}/end`, {}),
  share: (t: string, form: FormData) => storyReq<{ id: string; title: string }>(t, 'POST', '/recordings', form),
  shared: (t: string) => storyReq<SharedItem[]>(t, 'GET', '/recordings'),
  pastSessions: (t: string) => storyReq<InterviewSession[]>(t, 'GET', '/sessions'),
  stt: (t: string, blob: Blob) => {
    const f = new FormData();
    f.append('file', blob, blob.type.includes('ogg') ? 'turn.ogg' : blob.type.includes('mp4') ? 'turn.mp4' : 'turn.webm');
    return storyReq<{ text: string }>(t, 'POST', '/stt', f);
  },
};
