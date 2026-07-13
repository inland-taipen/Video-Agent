// src/components/VoiceUploadPanel.tsx
// Drag-and-drop audio uploader + 3-stage pipeline progress display

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { runTranscriber } from '../agents/transcriber';
import { ScriptPreview } from './ScriptPreview';
import { TranscriptionResult, TranscriptionState, StylePreset } from '../types';

interface Props {
  onUseStory: (story: string, style: StylePreset) => void;
}

type UploadPhase = 'drop' | 'processing' | 'done' | 'error';

const ACCEPTED = '.mp3,.wav,.m4a,.webm,.ogg,.aac,.flac';
const ACCEPTED_TYPES = [
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a',
  'audio/webm', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-m4a',
];

const STAGES = [
  { id: 'transcribing', label: 'Transcribing', icon: '🎙️' },
  { id: 'rough_script', label: 'Rough Script', icon: '📝' },
  { id: 'polished_script', label: 'Polished Story', icon: '🎬' },
  { id: 'done', label: 'Ready', icon: '✅' },
];

const STYLE_PRESETS: StylePreset[] = [
  'Storybook', 'Cinematic', 'Anime', 'Watercolor', 'Noir', 'Sci-Fi', 'Fantasy', 'Documentary',
  'Drone Footage', 'Macro', 'Dynamic', 'Photorealistic'
];
const STYLE_ICONS: Record<StylePreset, string> = {
  Storybook: '📖', Cinematic: '🎬', Anime: '✨', Watercolor: '🎨', Noir: '🌑',
  'Sci-Fi': '🚀', Fantasy: '🧙', Documentary: '📷',
  'Drone Footage': '🚁', Macro: '🔍', Dynamic: '⚡', Photorealistic: '📸'
};

export const VoiceUploadPanel: React.FC<Props> = ({ onUseStory }) => {
  const [style, setStyle] = useState<StylePreset>('Cinematic');

  // ── Upload state ──────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<UploadPhase>('drop');
  const [isDragging, setIsDragging] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [tsState, setTsState] = useState<TranscriptionState>({
    stage: 'idle', message: '', progress: 0,
  });
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isValidAudio = (file: File) =>
    ACCEPTED_TYPES.includes(file.type) || /\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i.test(file.name);

  const processFile = useCallback(async (file: File) => {
    if (!isValidAudio(file)) {
      setError('Please upload a valid audio file (MP3, WAV, M4A, WebM, OGG, AAC, FLAC).');
      setPhase('error');
      return;
    }

    // Read apiKey fresh from state (captured correctly inside callback)
    const currentKey = import.meta.env.VITE_GROQ_API_KEY;
    if (!currentKey) {
      setError('Missing VITE_GROQ_API_KEY in frontend/.env — get a free key at console.groq.com');
      setPhase('error');
      return;
    }
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
    setPhase('processing');
    setError('');

    try {
      const res = await runTranscriber(file, currentKey, (stage, message, progress) => {
        setTsState({ stage, message, progress });
      });
      setTsState({ stage: 'done', message: '✅ All done!', progress: 100 });
      setResult(res);
      setPhase('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setTsState({ stage: 'error', message: msg, progress: 0 });
      setPhase('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag events
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const reset = () => {
    setPhase('drop');
    setAudioFile(null);
    setAudioUrl(null);
    setResult(null);
    setError('');
    setTsState({ stage: 'idle', message: '', progress: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const stageIndex = STAGES.findIndex((s) => s.id === tsState.stage);
  const activeStageIndex = stageIndex === -1 ? 0 : stageIndex;

  // ── Phase: done → show ScriptPreview ──────────────────────────────────────
  if (phase === 'done' && result) {
    return (
      <div className="voice-panel">
        <ScriptPreview
          result={result}
          onUseScript={(story) => onUseStory(story, style)}
          onBack={reset}
        />
      </div>
    );
  }

  // ── Phase: drop / processing / error ──────────────────────────────────────
  return (
    <div className="voice-panel">
      <div className="voice-panel__header">
        <h2>🎙️ Voice Recording</h2>
        <p className="voice-panel__sub">
          Upload a voice recording — Groq Whisper will transcribe, and Gemini will craft a cinematic story
        </p>
      </div>


      {/* Visual style picker removed as per user request */}

      {/* Drop zone */}
      {phase !== 'processing' && (
        <div
          className={`voice-drop-zone ${isDragging ? 'voice-drop-zone--drag' : ''} ${phase === 'error' ? 'voice-drop-zone--error' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED}
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          <div className="vdz-icon">{isDragging ? '🎯' : '🎵'}</div>
          <p className="vdz-title">
            {isDragging ? 'Drop your recording here' : 'Drag & drop your audio file'}
          </p>
          <p className="vdz-sub">or click to browse — MP3, WAV, M4A, WebM, OGG, AAC, FLAC</p>
          <div className="vdz-badge">Up to ~20 MB</div>
        </div>
      )}

      {/* Audio player (once file is selected) */}
      {audioUrl && audioFile && (
        <div className="voice-audio-player">
          <div className="vap-meta">
            <span className="vap-icon">🎧</span>
            <div>
              <p className="vap-filename">{audioFile.name}</p>
              <p className="vap-size">{(audioFile.size / (1024 * 1024)).toFixed(2)} MB</p>
            </div>
          </div>
          <audio controls src={audioUrl} className="vap-audio" />
        </div>
      )}

      {/* Processing pipeline */}
      {phase === 'processing' && (
        <div className="voice-processing">
          <div className="vp-pipeline">
            {STAGES.map((s, i) => {
              const isDone = i < activeStageIndex;
              const isActive = i === activeStageIndex;
              return (
                <div key={s.id} className={`vp-stage ${isDone ? 'vp-stage--done' : ''} ${isActive ? 'vp-stage--active' : ''}`}>
                  <div className="vps-dot">
                    {isDone ? '✓' : isActive ? <span className="pulse-dot" /> : s.icon}
                  </div>
                  <div className="vps-label">{s.label}</div>
                  {i < STAGES.length - 1 && <div className="vps-line" />}
                </div>
              );
            })}
          </div>

          <div className="vp-progress-bar">
            <div
              className="vp-progress-fill"
              style={{ width: `${tsState.progress}%` }}
            />
          </div>

          <p className="vp-message">{tsState.message}</p>

          <div className="vp-stage-cards">
            <div className={`vp-card ${activeStageIndex >= 0 ? 'vp-card--active' : ''}`}>
              <span>🎙️</span>
              <span>Listening to the story narration</span>
            </div>
            <div className={`vp-card ${activeStageIndex >= 1 ? 'vp-card--active' : ''}`}>
              <span>📝</span>
              <span>Cleaning up speech into readable script</span>
            </div>
            <div className={`vp-card ${activeStageIndex >= 2 ? 'vp-card--active' : ''}`}>
              <span>🎬</span>
              <span>Crafting a cinematic screenplay</span>
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <div className="voice-error">
          <p className="ve-text">❌ {error}</p>
          <button className="ve-retry-btn" onClick={reset}>
            ↩ Try Again
          </button>
        </div>
      )}

      {/* Tips */}
      {phase === 'drop' && (
        <div className="voice-tips">
          <p className="vt-heading">💡 Tips for best results</p>
          <ul className="vt-list">
            <li>Works great with grandparent voice recordings, phone memos, or video audio</li>
            <li>Supports regional languages (Hindi, Tamil, Kannada, etc.) — auto-translated</li>
            <li>Quiet recordings work better than noisy environments</li>
            <li>Stories of 1–10 minutes produce the richest scripts</li>
          </ul>
        </div>
      )}
    </div>
  );
};
