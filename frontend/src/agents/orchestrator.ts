// src/agents/orchestrator.ts
// Agent 4: Runs the full pipeline, manages retries, emits progress

import { runScriptwriter } from './scriptwriter';
import { runVisualDirector } from './visualDirector';
import { runStoryboard, preloadImages } from './storyboard';
import { PipelineState, StoryboardFrame, StylePreset } from '../types';

export interface OrchestratorOptions {
  story: string;
  apiKey: string;
  style: StylePreset;
  seed: number;
  onProgress: (state: PipelineState) => void;
  onFrameLoaded: (index: number) => void;
}

export async function runPipeline(opts: OrchestratorOptions): Promise<StoryboardFrame[]> {
  const { story, apiKey, style, seed, onProgress, onFrameLoaded } = opts;

  onProgress({ stage: 'scriptwriter', message: '🎬 Scriptwriter analysing story…', progress: 10 });

  // Agent 1: Scriptwriter
  let scenes;
  try {
    scenes = await runScriptwriter(story, apiKey, style);
  } catch (err: unknown) {
    throw new Error(`Scriptwriter failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  onProgress({ stage: 'visual_director', message: `🎨 Visual Director enriching ${scenes.length} scenes…`, progress: 40 });

  // Agent 2: Visual Director
  let enrichedScenes;
  try {
    enrichedScenes = await runVisualDirector(scenes, apiKey, style);
  } catch (err: unknown) {
    console.warn('Visual Director error, using raw scenes:', err);
    enrichedScenes = scenes;
  }

  onProgress({ stage: 'storyboard', message: '🖼️ Building storyboard image URLs (Pollinations.ai)…', progress: 50 });

  // Agent 3: Storyboard (free Pollinations.ai images)
  const frames = runStoryboard(enrichedScenes, seed);

  onProgress({ stage: 'storyboard', message: `🖼️ Loading ${frames.length} images…`, progress: 55 });

  await preloadImages(frames, (index) => {
    onFrameLoaded(index);
    const pct = 55 + Math.round(((index + 1) / frames.length) * 40);
    onProgress({
      stage: 'storyboard',
      message: `🖼️ Loaded image ${index + 1} of ${frames.length}`,
      progress: pct,
    });
  });

  onProgress({ stage: 'done', message: `✅ ${frames.length} scenes ready!`, progress: 100 });

  return frames;
}
