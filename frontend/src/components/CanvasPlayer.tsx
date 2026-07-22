// src/components/CanvasPlayer.tsx
// Ken Burns canvas player with SpeechSynthesis narration and subtitle overlay

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { StoryboardFrame } from '../types';
import { sfxEngine } from '../utils/sfxEngine';

interface Props {
  frames: StoryboardFrame[];
  activeScene: number;
  onSceneChange: (index: number) => void;
}

const W = 1024;
const H = 576;
const FPS = 60;

// Ken Burns parameters per camera movement
type KBParams = { zStart: number; zEnd: number; xDir: number; yDir: number };

function getKBParams(movement: string): KBParams {
  switch (movement.toUpperCase()) {
    case 'ZOOM IN':   return { zStart: 1.0, zEnd: 1.4, xDir: 0, yDir: 0 };
    case 'ZOOM OUT':  return { zStart: 1.4, zEnd: 1.0, xDir: 0, yDir: 0 };
    case 'PAN LEFT':  return { zStart: 1.2, zEnd: 1.2, xDir: -1, yDir: 0 };
    case 'PAN RIGHT': return { zStart: 1.2, zEnd: 1.2, xDir: 1, yDir: 0 };
    case 'PAN UP':    return { zStart: 1.2, zEnd: 1.2, xDir: 0, yDir: -1 };
    case 'PAN DOWN':  return { zStart: 1.2, zEnd: 1.2, xDir: 0, yDir: 1 };
    default:          return { zStart: 1.0, zEnd: 1.0, xDir: 0, yDir: 0 };
  }
}

function drawSceneFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  progress: number, // 0–1 within scene
  kb: KBParams,
  narration: string,
  sceneMeta: string,
) {
  const zoom = kb.zStart + (kb.zEnd - kb.zStart) * progress;
  const maxPan = 80 * progress;
  const panX = kb.xDir * maxPan;
  const panY = kb.yDir * maxPan;

  // Compute draw dimensions preserving aspect ratio
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const canvasAspect = W / H;
  let drawW: number, drawH: number;
  if (imgAspect > canvasAspect) {
    drawH = H * zoom;
    drawW = drawH * imgAspect;
  } else {
    drawW = W * zoom;
    drawH = drawW / imgAspect;
  }

  const x = (W - drawW) / 2 + panX;
  const y = (H - drawH) / 2 + panY;

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, x, y, drawW, drawH);

  // Gradient vignette
  const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Scene meta label (top-left)
  ctx.font = 'bold 14px "Space Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText(sceneMeta, 16, 28);

  // Subtitle (bottom)
  if (narration.trim()) {
    const words = narration.split(' ');
    const maxChars = 72;
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > maxChars) {
        if (line) lines.push(line.trim());
        line = word;
      } else {
        line = (line + ' ' + word).trim();
      }
    }
    if (line) lines.push(line.trim());
    const showLines = lines.slice(0, 2);

    ctx.font = '16px "Inter", sans-serif';
    const lineH = 22;
    const totalH = showLines.length * lineH + 12;
    const boxY = H - totalH - 20;

    // Subtitle backdrop
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(12, boxY - 6, W - 24, totalH, 8);
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    showLines.forEach((l, i) => {
      ctx.fillText(l, W / 2, boxY + i * lineH + 16);
    });
    ctx.textAlign = 'left';
  }
}

export const CanvasPlayer: React.FC<Props> = ({ frames, activeScene, onSceneChange }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const currentSceneRef = useRef<number>(activeScene);
  const lastSpokenSceneRef = useRef<number | null>(null);
  const imagesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Preload images or videos
  useEffect(() => {
    frames.forEach((frame, i) => {
      if (frame.media_type === 'image' && !imagesRef.current.has(i)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = frame.media_url;
        imagesRef.current.set(i, img);
      }
    });
  }, [frames]);

  // Keep currentSceneRef in sync with prop
  useEffect(() => {
    currentSceneRef.current = activeScene;
  }, [activeScene]);

  const stopNarration = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch { /* ignore synth errors */ }
    }
    synthRef.current = null;
  }, []);

  const speakNarration = useCallback(
    (text: string, sceneIdx: number) => {
      if (muted || !text.trim()) return;
      if (lastSpokenSceneRef.current === sceneIdx) return; // avoid duplicate speech for same scene

      stopNarration();
      lastSpokenSceneRef.current = sceneIdx;

      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate = 0.95;
        utt.pitch = 1.0;
        utt.onend = () => { synthRef.current = null; };
        utt.onerror = () => { synthRef.current = null; };
        synthRef.current = utt;
        window.speechSynthesis.speak(utt);
      }
    },
    [muted, stopNarration],
  );

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sceneIdx = currentSceneRef.current;
    const frame = frames[sceneIdx];
    if (!frame) return;

    const img = imagesRef.current.get(sceneIdx);
    const elapsed = (performance.now() - startTimeRef.current) / 1000;
    const sceneDuration = frame.scene.duration || 3;
    const progress = Math.min(elapsed / sceneDuration, 1);
    const kb = getKBParams(frame.scene.camera_movement);

    if (frame.media_type === 'video') {
      ctx.fillStyle = '#0d0d1a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '24px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Video clip active', W / 2, H / 2 - 20);
      ctx.font = '16px Inter, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Preview clip in Storyboard grid.', W / 2, H / 2 + 20);
      ctx.textAlign = 'left';
    } else if (!img || !img.complete || !img.naturalWidth) {
      ctx.fillStyle = '#0d0d1a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '20px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Loading image…', W / 2, H / 2);
      ctx.textAlign = 'left';
      if (isPlaying) {
        rafRef.current = requestAnimationFrame(renderFrame);
      }
      return;
    } else {
      drawSceneFrame(
        ctx,
        img,
        progress,
        kb,
        frame.scene.narration,
        `${frame.scene.setting} · ${frame.scene.shot_type}`,
      );
    }

    if (progress >= 1 && isPlaying) {
      // Advance to next scene
      const nextIdx = sceneIdx + 1;
      if (nextIdx < frames.length) {
        currentSceneRef.current = nextIdx;
        onSceneChange(nextIdx);
        startTimeRef.current = performance.now();
        speakNarration(frames[nextIdx].scene.narration, nextIdx);
        sfxEngine.playSFX(frames[nextIdx].scene.sfx || '', frames[nextIdx].scene.style || '');
      } else {
        // Reached end of storyboard — stop cleanly
        setIsPlaying(false);
        stopNarration();
        sfxEngine.stopSFX();
        lastSpokenSceneRef.current = null;
        return;
      }
    }

    if (isPlaying) {
      rafRef.current = requestAnimationFrame(renderFrame);
    }
  }, [frames, isPlaying, onSceneChange, speakNarration, stopNarration]);

  useEffect(() => {
    if (isPlaying) {
      if (lastSpokenSceneRef.current !== activeScene) {
        startTimeRef.current = performance.now();
        speakNarration(frames[activeScene]?.scene.narration ?? '', activeScene);
        sfxEngine.playSFX(frames[activeScene]?.scene.sfx || '', frames[activeScene]?.scene.style || '');
      }
      rafRef.current = requestAnimationFrame(renderFrame);
    } else {
      cancelAnimationFrame(rafRef.current);
      stopNarration();
      sfxEngine.stopSFX();
      lastSpokenSceneRef.current = null;
    }
    return () => {
      cancelAnimationFrame(rafRef.current);
      sfxEngine.stopSFX();
    };
  }, [isPlaying, renderFrame, frames, activeScene, speakNarration, stopNarration]);

  // Render static frame when scene changes while paused
  useEffect(() => {
    if (!isPlaying) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const frame = frames[activeScene];
      
      if (frame?.media_type === 'video') {
        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Video clip active', W / 2, H / 2 - 20);
        ctx.font = '16px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText('Preview clip in Storyboard grid.', W / 2, H / 2 + 20);
        ctx.textAlign = 'left';
        return;
      }

      const img = imagesRef.current.get(activeScene);
      if (!img) return;

      const tryDraw = () => {
        if (img.complete && img.naturalWidth) {
          drawSceneFrame(ctx, img, 0, getKBParams(frame?.scene.camera_movement ?? 'STATIC'),
            frame?.scene.narration ?? '', frame?.scene.setting ?? '');
        } else {
          img.onload = () => drawSceneFrame(ctx, img, 0, getKBParams(frame?.scene.camera_movement ?? 'STATIC'),
            frame?.scene.narration ?? '', frame?.scene.setting ?? '');
        }
      };
      tryDraw();
    }
  }, [activeScene, frames, isPlaying]);

  const handlePlayPause = () => {
    if (!frames.length) return;
    setIsPlaying((v) => !v);
  };

  const handlePrev = () => {
    const prev = Math.max(0, activeScene - 1);
    lastSpokenSceneRef.current = null;
    onSceneChange(prev);
    startTimeRef.current = performance.now();
  };

  const handleNext = () => {
    const next = Math.min(frames.length - 1, activeScene + 1);
    lastSpokenSceneRef.current = null;
    onSceneChange(next);
    startTimeRef.current = performance.now();
  };

  const totalDuration = frames.reduce((s, f) => s + (f.scene.duration || 3), 0);
  const frame = frames[activeScene];

  return (
    <div className="theater-section">
      <h3 className="section-title">🎭 Theater</h3>
      <div className="theater-wrapper">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="theater-canvas"
          style={{ width: '100%', height: 'auto', maxWidth: `${W}px` }}
        />

        {/* Controls */}
        <div className="theater-controls">
          <div className="theater-controls__left">
            <button className="ctrl-btn" onClick={handlePrev} disabled={activeScene === 0}>
              ⏮
            </button>
            <button className="ctrl-btn ctrl-btn--play" onClick={handlePlayPause}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button className="ctrl-btn" onClick={handleNext} disabled={activeScene >= frames.length - 1}>
              ⏭
            </button>
            <button
              className={`ctrl-btn ${muted ? 'ctrl-btn--muted' : ''}`}
              onClick={() => { setMuted((v) => !v); stopNarration(); }}
              title={muted ? 'Unmute narration' : 'Mute narration'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          </div>

          <div className="theater-controls__info">
            <span className="scene-counter">
              Scene {activeScene + 1} / {frames.length}
            </span>
            <span className="total-duration">{totalDuration}s total</span>
          </div>
        </div>

        {/* Scene info strip */}
        {frame && (
          <div className="theater-info-strip">
            <div className="tis-setting">{frame.scene.setting}</div>
            <div className="tis-badges">
              <span className="scene-badge">{frame.scene.shot_type}</span>
              <span className="scene-badge">{frame.scene.camera_movement}</span>
              <span className="scene-badge">{frame.scene.transition}</span>
              {frame.scene.sfx && <span className="scene-badge" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8' }}>🔊 {frame.scene.sfx}</span>}
            </div>
            {frame.scene.dialogue.length > 0 && (
              <div className="tis-dialogue">
                {frame.scene.dialogue.map((d, i) => (
                  <p key={i}>
                    <strong>{d.speaker}:</strong> {d.line}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
