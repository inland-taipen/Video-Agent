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
  onProgress({ stage: 'visual_director', message: `🎨 Visual Director enriching ${scenes.length} scenes…`, progress: 35 });

  // Agent 2: Visual Director
  let enrichedScenes;
  try {
    enrichedScenes = await runVisualDirector(scenes, apiKey, style);
  } catch (err: unknown) {
    console.warn('Visual Director error, using raw scenes:', err);
    enrichedScenes = scenes;
  }

  onProgress({ stage: 'storyboard', message: `🖼️ Imagen 3 generating ${enrichedScenes.length} images…`, progress: 50 });

  // Agent 3: Storyboard — Imagen 3 image generation (parallel)
  const frames = await runStoryboard(enrichedScenes, seed, apiKey, (index) => {
    onFrameLoaded(index);
    const pct = 50 + Math.round(((index + 1) / enrichedScenes.length) * 45);
    onProgress({
      stage: 'storyboard',
      message: `🖼️ Generated image ${index + 1} of ${enrichedScenes.length}`,
      progress: pct,
    });
  });

  // preloadImages is now a no-op since images are base64 data URLs
  await preloadImages(frames, () => {});

  onProgress({ stage: 'done', message: `✅ ${frames.length} scenes ready!`, progress: 100 });

  return frames;
}
