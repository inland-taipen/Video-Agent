// src/App.tsx
import React, { useState, useCallback } from 'react';
import { InputPanel } from './components/InputPanel';
import { VoiceUploadPanel } from './components/VoiceUploadPanel';
import { PipelineStatus } from './components/PipelineStatus';
import { StoryboardGrid } from './components/StoryboardGrid';
import { CanvasPlayer } from './components/CanvasPlayer';
import { ExportPanel } from './components/ExportPanel';
import { runPipeline } from './agents/orchestrator';
import { PipelineState, StoryboardFrame, StylePreset } from './types';


const IDLE_STATE: PipelineState = { stage: 'idle', message: '', progress: 0 };

type InputMode = 'write' | 'voice';

export default function App() {
  const [frames, setFrames] = useState<StoryboardFrame[]>([]);
  const [pipelineState, setPipelineState] = useState<PipelineState>(IDLE_STATE);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeScene, setActiveScene] = useState(0);
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('write');

  const handleGenerate = useCallback(
    async (story: string, st: StylePreset, seed: number) => {
      setIsGenerating(true);
      setFrames([]);
      setLoadedImages(new Set());
      setActiveScene(0);
      setError('');
      setPipelineState({ stage: 'scriptwriter', message: 'Starting pipeline…', progress: 5 });

      const groqKey = import.meta.env.VITE_GROQ_API_KEY?.trim();

      if (!groqKey) {
        setError('Missing VITE_GROQ_API_KEY in frontend/.env — get a free key at console.groq.com');
        setPipelineState({ stage: 'error', message: 'Missing Groq API key', progress: 0 });
        setIsGenerating(false);
        return;
      }

      try {
        const result = await runPipeline({
          story,
          apiKey: groqKey,
          style: st,
          seed,
          onProgress: (state) => setPipelineState(state),
          onFrameLoaded: (i) => {
            setLoadedImages((prev) => {
              const next = new Set(prev);
              next.add(i);
              return next;
            });
          },
        });
        setFrames(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setPipelineState({ stage: 'error', message: msg, progress: 0 });
      } finally {
        setIsGenerating(false);
      }
    },
    [],
  );

  const handleVoiceStory = useCallback(
    (story: string, st: StylePreset) => {
      handleGenerate(story, st, Math.floor(Math.random() * 99999));
    },
    [handleGenerate],
  );

  const hasFrames = frames.length > 0;

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <div className="header-logo">
            <span className="logo-icon">🎬</span>
            <div>
              <h1 className="header-title">StoryViz</h1>
              <p className="header-sub">Story → Storyboard → Video</p>
            </div>
          </div>
          <div className="header-badges">
            <span className="badge">Groq (Llama 3)</span>
            <span className="badge">Pollinations.ai</span>
            <span className="badge">FFmpeg</span>
            <span className="badge badge--new">🎙️ Voice</span>
          </div>
        </div>
      </header>

      <main className="app-main">
        {/* Left sidebar */}
        <aside className="sidebar">
          {/* ── Tab switcher ── */}
          <div className="input-tab-switcher">
            <button
              id="tab-write"
              className={`itab ${inputMode === 'write' ? 'itab--active' : ''}`}
              onClick={() => setInputMode('write')}
            >
              ✍️ Write Story
            </button>
            <button
              id="tab-voice"
              className={`itab ${inputMode === 'voice' ? 'itab--active' : ''}`}
              onClick={() => setInputMode('voice')}
            >
              🎙️ Voice Recording
            </button>
          </div>

          {/* ── Write mode ── */}
          {inputMode === 'write' && (
            <InputPanel onGenerate={handleGenerate} isGenerating={isGenerating} />
          )}

          {/* ── Voice mode ── */}
          {inputMode === 'voice' && (
            <VoiceUploadPanel
              onUseStory={(story, st) => handleGenerate(story, st, 42)}
            />
          )}
          {hasFrames && <ExportPanel frames={frames} />}
        </aside>

        {/* Main content area */}
        <div className="content-area">
          {/* Pipeline status */}
          {(isGenerating || pipelineState.stage !== 'idle') && (
            <PipelineStatus state={pipelineState} />
          )}

          {/* Error */}
          {error && (
            <div className="alert alert--error">
              ❌ <strong>Pipeline Error:</strong> {error}
            </div>
          )}

          {/* Theater player */}
          {hasFrames && (
            <CanvasPlayer
              frames={frames}
              activeScene={activeScene}
              onSceneChange={setActiveScene}
            />
          )}

          {/* Storyboard grid */}
          {hasFrames && (
            <StoryboardGrid
              frames={frames}
              activeScene={activeScene}
              loadedImages={loadedImages}
              onSelectScene={(i) => {
                setActiveScene(i);
              }}
            />
          )}

          {/* Empty state */}
          {!hasFrames && !isGenerating && pipelineState.stage === 'idle' && (
            <div className="empty-state">
              <div className="empty-icon">🎬</div>
              <h2>Ready to Visualize</h2>
              <p>
                Write a story or upload a voice recording — the AI will craft a cinematic
                storyboard video that captures its essence.
              </p>
              <div className="empty-features">
                <div className="feat">✍️ AI Scene Breakdown</div>
                <div className="feat">🎨 Style-guided Images</div>
                <div className="feat">🎭 Ken Burns Player</div>
                <div className="feat">📥 MP4 Export</div>
                <div className="feat feat--new">🎙️ Voice Upload</div>
                <div className="feat feat--new">📝 Auto Scripting</div>
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="app-footer">
        <p>
          Powered by{' '}
          <a href="https://groq.com" target="_blank" rel="noopener noreferrer">
            Groq API
          </a>{' '}
          ·{' '}
          <a href="https://pollinations.ai/" target="_blank" rel="noopener noreferrer">
            Pollinations.ai
          </a>{' '}
          · FFmpeg · gTTS
        </p>
      </footer>
    </div>
  );
}
