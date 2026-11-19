// src/legacy/call/Visualizer.tsx — soft audio ring around the portrait.
import React, { useEffect, useRef } from 'react';
import type { Phase } from './useVoiceCall';

interface Props {
  phase: Phase;
  level: React.MutableRefObject<number>;
  size: number;
}

const COLORS: Partial<Record<Phase, string>> = {
  listening: '240, 200, 150',
  speaking: '255, 222, 180',
  thinking: '200, 170, 140',
};

export function Visualizer({ phase, level, size }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let smooth = 0;
    let raf = 0;
    let t = 0;
    const BARS = 72;
    const centre = size / 2;
    const inner = size * 0.36;

    const draw = () => {
      t += 1;
      const p = phaseRef.current;
      // speaking levels come from word-boundary pulses; let them decay naturally
      if (p === 'speaking') level.current *= 0.93;
      const target = p === 'thinking' ? 0.18 + 0.08 * Math.sin(t / 12) : Math.min(1, level.current);
      smooth += (target - smooth) * 0.18;
      ctx.clearRect(0, 0, size, size);
      const rgb = COLORS[p] || '180, 160, 140';

      // glow
      const g = ctx.createRadialGradient(centre, centre, inner * 0.9, centre, centre, inner * (1.35 + smooth * 0.35));
      g.addColorStop(0, `rgba(${rgb}, ${0.18 + smooth * 0.3})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(centre, centre, inner * 1.7, 0, Math.PI * 2);
      ctx.fill();

      if (!reduced && (p === 'listening' || p === 'speaking' || p === 'thinking')) {
        ctx.strokeStyle = `rgba(${rgb}, 0.85)`;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        for (let i = 0; i < BARS; i++) {
          const a = (i / BARS) * Math.PI * 2;
          const wave = 0.5 + 0.5 * Math.sin(a * 3 + t / 9) * Math.cos(a * 2 - t / 14);
          const len = 4 + smooth * size * 0.12 * (0.35 + wave * 0.65);
          const r0 = inner + 8;
          ctx.beginPath();
          ctx.moveTo(centre + Math.cos(a) * r0, centre + Math.sin(a) * r0);
          ctx.lineTo(centre + Math.cos(a) * (r0 + len), centre + Math.sin(a) * (r0 + len));
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, level]);

  return <canvas ref={canvas} className="lg-viz" style={{ width: size, height: size }} aria-hidden="true" />;
}
