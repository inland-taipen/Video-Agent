// src/components/InputPanel.tsx
import React, { useState, useRef, useEffect } from 'react';
import { StylePreset } from '../types';

interface Props {
  onGenerate: (story: string, style: StylePreset, seed: number) => void;
  isGenerating: boolean;
}

const STYLE_PRESETS: StylePreset[] = [
  'Cinematic', 'Anime', 'Watercolor', 'Noir', 'Sci-Fi', 'Fantasy', 'Documentary',
];

const STYLE_ICONS: Record<StylePreset, string> = {
  Cinematic: '🎬', Anime: '✨', Watercolor: '🎨', Noir: '🌑',
  'Sci-Fi': '🚀', Fantasy: '🧙', Documentary: '📷',
};

const EXAMPLE_STORY = `A lone astronaut drifts through the wreckage of a destroyed space station. 
She finds a distress beacon still blinking. Against all odds, she activates it — 
and discovers she's not as alone as she thought. Something massive stirs in the dark.`;

export const InputPanel: React.FC<Props> = ({ onGenerate, isGenerating }) => {
  const [story, setStory] = useState('');
  const [style, setStyle] = useState<StylePreset>('Cinematic');
  const [seed, setSeed] = useState(42);
  const [isListening, setIsListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const toggleMic = () => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { alert('Web Speech API is only supported in Chrome/Edge.'); return; }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    recognitionRef.current = rec;

    let finalTranscript = story;
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + ' ';
        } else {
          interim = e.results[i][0].transcript;
        }
      }
      setStory(finalTranscript + interim);
    };
    rec.onend = () => setIsListening(false);
    rec.start();
    setIsListening(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!story.trim()) return;
    onGenerate(story.trim(), style, seed);
  };

  return (
    <div className="input-panel">
      <div className="input-panel__header">
        <h2>Craft Your Story</h2>
        <p className="input-panel__sub">
          Write or speak a story and watch it transform into a cinematic storyboard video
        </p>
      </div>

      <form onSubmit={handleSubmit} className="input-form">
        <hr className="divider" />
        <div className="form-group">
          <label className="form-label">🎨 Visual Style</label>
          <div className="style-grid">
            {STYLE_PRESETS.map((s) => (
              <button
                key={s}
                type="button"
                className={`style-chip ${style === s ? 'style-chip--active' : ''}`}
                onClick={() => setStyle(s)}
              >
                <span>{STYLE_ICONS[s]}</span>
                <span>{s}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Story textarea */}
        <div className="form-group">
          <label className="form-label">
            📖 Story
            <button type="button" className="link-hint" onClick={() => setStory(EXAMPLE_STORY)}>
              Load example →
            </button>
          </label>
          <div className="textarea-wrapper">
            <textarea
              value={story}
              onChange={(e) => setStory(e.target.value)}
              placeholder="Write your story here (up to ~500 words). The AI will break it into cinematic scenes…"
              className="form-textarea"
              rows={8}
            />
            <button
              type="button"
              className={`mic-btn ${isListening ? 'mic-btn--active' : ''}`}
              onClick={toggleMic}
              title={isListening ? 'Stop recording' : 'Dictate story'}
            >
              {isListening ? '⏹' : '🎤'}
            </button>
          </div>
          <div className="word-count">{story.trim() ? story.trim().split(/\s+/).length : 0} words</div>
        </div>

        {/* Seed */}
        <div className="form-group form-group--row">
          <label className="form-label" style={{ flex: 1 }}>
            🎲 Seed (for reproducibility)
          </label>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            className="form-input seed-input"
            min={0}
            max={99999}
          />
          <button
            type="button"
            className="btn-icon"
            onClick={() => setSeed(Math.floor(Math.random() * 99999))}
            title="Random seed"
          >
            🎲
          </button>
        </div>

        <button
          type="submit"
          className="btn-generate"
          disabled={isGenerating || !story.trim()}
        >
          {isGenerating ? (
            <span className="btn-spinner">
              <span className="spinner" /> Generating…
            </span>
          ) : (
            '⚡ Generate Storyboard'
          )}
        </button>
      </form>
    </div>
  );
};
