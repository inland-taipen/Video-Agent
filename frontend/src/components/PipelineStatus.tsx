// src/components/PipelineStatus.tsx
import React from 'react';
import { PipelineState } from '../types';

interface Props {
  state: PipelineState;
}

const STAGES = [
  { key: 'scriptwriter', label: 'Scriptwriter', icon: '✍️' },
  { key: 'visual_director', label: 'Visual Director', icon: '🎨' },
  { key: 'storyboard', label: 'Storyboard', icon: '🖼' },
  { key: 'done', label: 'Complete', icon: '✅' },
];

export const PipelineStatus: React.FC<Props> = ({ state }) => {
  const stageIndex = STAGES.findIndex((s) => s.key === state.stage);

  return (
    <div className="pipeline-status">
      <div className="pipeline-stages">
        {STAGES.map((s, i) => {
          const isDone = i < stageIndex || state.stage === 'done';
          const isActive = s.key === state.stage;
          return (
            <div
              key={s.key}
              className={`pipeline-stage ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}
            >
              <div className="stage-dot">
                {isDone ? '✓' : isActive ? <span className="pulse-dot" /> : i + 1}
              </div>
              <div className="stage-label">
                {s.icon} {s.label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="pipeline-progress-bar">
        <div
          className="pipeline-progress-fill"
          style={{ width: `${state.progress}%` }}
        />
      </div>
      <p className="pipeline-message">{state.message}</p>
    </div>
  );
};
