// src/components/StoryboardGrid.tsx
import React from 'react';
import { StoryboardFrame } from '../types';

interface Props {
  frames: StoryboardFrame[];
  activeScene: number;
  loadedImages: Set<number>;
  onSelectScene: (index: number) => void;
}

const MOVEMENT_ICONS: Record<string, string> = {
  'STATIC': '◾',
  'ZOOM IN': '🔍',
  'ZOOM OUT': '🔭',
  'PAN LEFT': '◀',
  'PAN RIGHT': '▶',
  'PAN UP': '▲',
  'PAN DOWN': '▼',
};

export const StoryboardGrid: React.FC<Props> = ({ frames, activeScene, loadedImages, onSelectScene }) => {
  return (
    <div className="storyboard-section">
      <h3 className="section-title">🎞 Storyboard</h3>
      <div className="storyboard-grid">
        {frames.map((frame, i) => {
          const isActive = i === activeScene;
          const isLoaded = loadedImages.has(i);

          return (
            <div
              key={i}
              className={`scene-card ${isActive ? 'scene-card--active' : ''}`}
              onClick={() => onSelectScene(i)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelectScene(i)}
            >
              {/* Image */}
              <div className="scene-card__img-wrap">
                {isLoaded ? (
                  frame.media_type === 'video' ? (
                    <video
                      src={frame.media_url}
                      className="scene-card__img"
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={frame.media_url}
                      alt={`Scene ${frame.scene.scene_number}`}
                      className="scene-card__img"
                      loading="lazy"
                    />
                  )
                ) : (
                  <div className="scene-card__skeleton">
                    <div className="skeleton-shimmer" />
                    <span className="skeleton-text">Loading…</span>
                  </div>
                )}
                <div className="scene-card__overlay">
                  <span className="scene-num">#{frame.scene.scene_number}</span>
                  <span className="scene-duration">{frame.scene.duration}s</span>
                </div>
              </div>

              {/* Meta */}
              <div className="scene-card__meta">
                <div className="scene-setting">{frame.scene.setting}</div>
                <div className="scene-info-row">
                  <span className="scene-badge shot">{frame.scene.shot_type}</span>
                  <span className="scene-badge movement">
                    {MOVEMENT_ICONS[frame.scene.camera_movement] ?? '◾'}{' '}
                    {frame.scene.camera_movement}
                  </span>
                </div>
                <p className="scene-narration">{frame.scene.narration.slice(0, 80)}{frame.scene.narration.length > 80 ? '…' : ''}</p>
              </div>

              {/* Active indicator */}
              {isActive && <div className="scene-card__active-bar" />}
            </div>
          );
        })}
      </div>
    </div>
  );
};
