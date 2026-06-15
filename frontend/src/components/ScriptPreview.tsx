// src/components/ScriptPreview.tsx
// 3-column editable script comparison: Raw → Rough → Polished

import React, { useState } from 'react';
import { TranscriptionResult } from '../types';

interface Props {
  result: TranscriptionResult;
  onUseScript: (script: string) => void;
  onBack: () => void;
}

interface Column {
  key: keyof Pick<TranscriptionResult, 'rawTranscript' | 'roughScript' | 'polishedScript'>;
  label: string;
  icon: string;
  color: string;
  description: string;
}

const COLUMNS: Column[] = [
  {
    key: 'rawTranscript',
    label: 'Raw Transcript',
    icon: '🎙️',
    color: '#06b6d4',
    description: 'Exactly what was said',
  },
  {
    key: 'roughScript',
    label: 'Rough Script',
    icon: '📝',
    color: '#f59e0b',
    description: 'Cleaned up, original voice preserved',
  },
  {
    key: 'polishedScript',
    label: 'Polished Story',
    icon: '🎬',
    color: '#7c5cfc',
    description: 'Ready for storyboarding',
  },
];

export const ScriptPreview: React.FC<Props> = ({ result, onUseScript, onBack }) => {
  const [edited, setEdited] = useState<TranscriptionResult>({ ...result });
  const [activeColumn, setActiveColumn] = useState<Column['key']>('polishedScript');

  const wordCount = (text: string) =>
    text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="script-preview">
      {/* Header */}
      <div className="script-preview__header">
        <button className="sp-back-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="sp-title-block">
          <h2 className="sp-title">Script Comparison</h2>
          {result.detectedLanguage && result.detectedLanguage.toLowerCase() !== 'english' && (
            <span className="sp-lang-badge">
              🌐 Detected: {result.detectedLanguage}
            </span>
          )}
        </div>
      </div>

      {/* 3-column grid */}
      <div className="script-columns">
        {COLUMNS.map((col) => {
          const isActive = activeColumn === col.key;
          return (
            <div
              key={col.key}
              className={`script-col ${isActive ? 'script-col--active' : ''}`}
              style={{ '--col-color': col.color } as React.CSSProperties}
            >
              <div className="script-col__header" onClick={() => setActiveColumn(col.key)}>
                <div className="script-col__title">
                  <span className="script-col__icon">{col.icon}</span>
                  <span className="script-col__label">{col.label}</span>
                </div>
                <span className="script-col__desc">{col.description}</span>
                <div className="script-col__meta">
                  <span className="sc-word-count">{wordCount(edited[col.key])} words</span>
                </div>
              </div>

              <textarea
                className="script-col__textarea"
                value={edited[col.key]}
                onChange={(e) =>
                  setEdited((prev) => ({ ...prev, [col.key]: e.target.value }))
                }
                spellCheck={false}
              />

              <button
                className="script-col__use-btn"
                onClick={() => onUseScript(edited[col.key])}
              >
                Use this version →
              </button>
            </div>
          );
        })}
      </div>

      {/* Quick-use footer */}
      <div className="script-preview__footer">
        <p className="sp-footer-hint">
          ✏️ All columns are editable. Choose which version to use as the story input.
        </p>
        <button
          className="btn-generate"
          onClick={() => onUseScript(edited.polishedScript)}
        >
          ⚡ Use Polished Story → Generate Storyboard
        </button>
      </div>
    </div>
  );
};
