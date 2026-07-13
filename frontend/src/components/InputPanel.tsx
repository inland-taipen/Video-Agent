// src/components/InputPanel.tsx
import React, { useState, useRef } from 'react';
import { StylePreset, GenerationMode, MODE_CONFIG } from '../types';

interface Props {
  onGenerate: (story: string, style: StylePreset, seed: number, mode: GenerationMode) => void;
  isGenerating: boolean;
}

const STYLE_PRESETS: StylePreset[] = [
  'Storybook', 'Cinematic', 'Anime', 'Watercolor', 'Noir', 'Sci-Fi', 'Fantasy', 'Documentary',
  'Drone Footage', 'Macro', 'Dynamic', 'Photorealistic'
];

const STYLE_ICONS: Record<StylePreset, string> = {
  Storybook: '📖', Cinematic: '🎬', Anime: '✨', Watercolor: '🎨', Noir: '🌑',
  'Sci-Fi': '🚀', Fantasy: '🧙', Documentary: '📷',
  'Drone Footage': '🚁', Macro: '🔍', Dynamic: '⚡', Photorealistic: '📸'
};

const EXAMPLE_STORIES: Record<GenerationMode, string> = {
  animated: `A lone astronaut drifts through the wreckage of a destroyed space station.
She finds a distress beacon still blinking. Against all odds, she activates it —
and discovers she's not as alone as she thought. Something massive stirs in the dark.`,
  documentary: `The deep ocean trenches — unexplored, mysterious, and teeming with life.
From bioluminescent creatures navigating the eternal darkness to the hydrothermal vents
that sustain entire ecosystems, the abyss holds secrets that challenge our understanding of life itself.`,
  storybook: `Little Maisie the rabbit discovers a tiny glowing door at the base of the
old oak tree. When she knocks, a friendly bluebird invites her inside — where a whole
village of woodland creatures have been waiting for someone just like her to share their warmth.`,
};

const PLACEHOLDER: Record<GenerationMode, string> = {
  animated: 'Write your anime story (up to ~500 words). The AI will break it into cinematic scenes…',
  documentary: 'Describe a topic for your documentary (e.g. "The deep oceans", "Ancient Rome", "Bees and pollination")…',
  storybook: 'Write a gentle tale for your storybook (e.g. "A little fox who finds a lost star and returns it to the sky")…',
};

const GENERATE_LABEL: Record<GenerationMode, string> = {
  animated: '🎌 Generate Animated Story',
  documentary: '🌍 Generate Documentary',
  storybook: '📚 Create Storybook',
};

const TEXTAREA_LABEL: Record<GenerationMode, string> = {
  animated: '📖 Your Story',
  documentary: '🌍 Topic',
  storybook: '🌸 Your Tale',
};

// Mode card accent colors (used via CSS class)
const MODE_ACCENT: Record<GenerationMode, string> = {
  animated: 'mode-card--sakura',
  documentary: 'mode-card--sage',
  storybook: 'mode-card--lavender',
};

export const InputPanel: React.FC<Props> = ({ onGenerate, isGenerating }) => {
  const [story, setStory] = useState('');
  const [style, setStyle] = useState<StylePreset>('Watercolor');
  const [seed, setSeed] = useState(42);
  const [mode, setMode] = useState<GenerationMode>('storybook');
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
    onGenerate(story.trim(), style, seed, mode);
  };

  const GENERATION_MODES = Object.entries(MODE_CONFIG) as [GenerationMode, typeof MODE_CONFIG[GenerationMode]][];

  return (
    <div className="input-panel">
      <div className="input-panel__header">
        <div className="sparkle-decoration" aria-hidden="true">
          <span>✨</span><span>✨</span><span>✨</span>
        </div>
        <h2>Craft Your Story</h2>
        <p className="input-panel__sub">
          Choose your world and weave a tale to remember
        </p>
      </div>

      <form onSubmit={handleSubmit} className="input-form">

        {/* ── Generation Mode Cards ── */}
        <div className="form-group">
          <label className="form-label form-label--mode">✨ Choose Your World</label>
          <div className="mode-cards">
            {GENERATION_MODES.map(([key, cfg]) => (
              <button
                key={key}
                type="button"
                className={`mode-card ${MODE_ACCENT[key]} ${mode === key ? 'mode-card--active' : ''}`}
                onClick={() => setMode(key)}
                aria-pressed={mode === key}
              >
                <span className="mode-card__icon">{cfg.icon}</span>
                <span className="mode-card__label">{cfg.label}</span>
                <span className="mode-card__desc">{cfg.description}</span>
                {mode === key && <span className="mode-card__check">✓</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Removed floral divider and visual style picker as per user request */}

        {/* ── Story textarea ── */}
        <div className="form-group">
          <label className="form-label">
            {TEXTAREA_LABEL[mode]}
            <button type="button" className="link-hint" onClick={() => setStory(EXAMPLE_STORIES[mode])}>
              Load example →
            </button>
          </label>
          <div className="textarea-wrapper">
            <textarea
              value={story}
              onChange={(e) => setStory(e.target.value)}
              placeholder={PLACEHOLDER[mode]}
              className="form-textarea"
              rows={7}
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

        {/* ── Seed ── */}
        <div className="form-group form-group--row">
          <label className="form-label" style={{ flex: 1 }}>
            🎲 Seed
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
          className={`btn-generate btn-generate--${mode}`}
          disabled={isGenerating || !story.trim()}
        >
          {isGenerating ? (
            <span className="btn-spinner">
              <span className="spinner" /> Weaving your story…
            </span>
          ) : (
            GENERATE_LABEL[mode]
          )}
        </button>
      </form>
    </div>
  );
};
