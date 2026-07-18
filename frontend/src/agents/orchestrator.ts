// src/agents/orchestrator.ts
// Agent 4 (V2.1): Pipeline Orchestrator — manages state, validation, memory, retries
//
// V2.1 changes:
// - Scriptwriter now returns { scenes, characters } instead of just Scene[]
// - Character memory is extracted deterministically after scriptwriting
// - Scenes are validated and auto-fixed before Visual Director
// - If critical validation errors exist, a targeted patch prompt is attempted
// - Visual Director now returns { scenes, globalStyle }
// - Memory (with globalStyle) is passed to Storyboard for prompt compilation
// - New pipeline stage: 'validating'

import { runScriptwriter } from './scriptwriter';
import { runVisualDirector } from './visualDirector';
import { runStoryboard, preloadImages } from './storyboard';
import { runVeo } from './veo';
import { extractMemory, StoryMemory } from './memory';
import { validateStory, autoFixScenes, buildPatchPrompt } from './validator';
import { callLLM } from './llm';
import { PipelineState, StoryboardFrame, StylePreset, Scene, GenerationMode } from '../types';

export interface OrchestratorOptions {
  story: string;
  apiKey: string;
  style: StylePreset;
  seed: number;
  mode: GenerationMode;        // 'animated' | 'documentary' | etc.
  useVeo?: boolean;            // optional: generate 10s video clips with Veo
  onProgress: (state: PipelineState) => void;
  onFrameLoaded: (index: number) => void;
}

export async function runPipeline(opts: OrchestratorOptions): Promise<StoryboardFrame[]> {
  const { story, apiKey, style, seed, mode, useVeo, onProgress, onFrameLoaded } = opts;

  const modeIcon = mode === 'documentary' ? '🌍' : '🎌';

  // ── Stage 1: Story Generation (LLM Call 1) ───────────────────────────────────
  onProgress({ stage: 'scriptwriter', message: `${modeIcon} Crafting your ${mode === 'documentary' ? 'documentary' : 'story'}…`, progress: 10 });

  let storyResult;
  try {
    storyResult = await runScriptwriter(story, apiKey, style, mode);
  } catch (err: unknown) {
    throw new Error(`Scriptwriter failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let { scenes, characters } = storyResult;

  // ── Stage 2: Validation + Memory (Deterministic) ──────────────────────
  onProgress({ stage: 'scriptwriter', message: '✅ Validating story structure…', progress: 25 });

  // Extract character memory from the story
  const memory = extractMemory(scenes, characters);

  // Auto-fix minor issues (clamped durations, sequential numbering, transitions)
  scenes = autoFixScenes(scenes);

  // Validate against production rules
  const validation = validateStory(scenes, memory);

  if (validation.warnings.length > 0) {
    console.info('[Validator] Warnings:', validation.warnings);
  }

  if (!validation.valid) {
    console.warn('[Validator] Errors found:', validation.errors);

    // Attempt targeted patch (only for fixable errors like missing narration)
    const patchPrompt = buildPatchPrompt(scenes, validation.errors);
    if (patchPrompt) {
      onProgress({ stage: 'scriptwriter', message: '🔧 Fixing story issues…', progress: 28 });
      try {
        const patchText = await callLLM(apiKey, patchPrompt, true);
        let clean = patchText.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
        const m = clean.match(/\[[\s\S]*\]/);
        if (m) {
          const patched: Partial<Scene>[] = JSON.parse(m[0]);
          // Merge patched scenes back
          for (const patch of patched) {
            const idx = scenes.findIndex((s) => s.scene_number === patch.scene_number);
            if (idx >= 0) {
              scenes[idx] = { ...scenes[idx], ...patch };
            }
          }
        }
      } catch (patchErr) {
        console.warn('[Validator] Patch attempt failed, proceeding with original:', patchErr);
      }
    }
  }

  // ── Stage 3: Visual Direction (LLM Call 2) ────────────────────────────
  onProgress({ stage: 'visual_director', message: `🎨 Visual Director composing ${scenes.length} scenes…`, progress: 35 });

  let enrichedScenes: Scene[];
  let globalStyle = '';
  try {
    const vdResult = await runVisualDirector(scenes, apiKey, style, mode);
    enrichedScenes = vdResult.scenes;
    globalStyle = vdResult.globalStyle;
  } catch (err: unknown) {
    console.warn('Visual Director error, using raw scenes:', err);
    enrichedScenes = scenes;
  }

  // Update memory with the global style from Visual Director
  const finalMemory: StoryMemory = {
    ...memory,
    globalStyle,
  };

  // ── Stage 4: Storyboard — Image Generation (Parallel) ─────────────────
  onProgress({ stage: 'storyboard', message: `🖼️ Generating ${enrichedScenes.length} illustrations…`, progress: 50 });

  const frames = await runStoryboard(enrichedScenes, seed, apiKey, (index) => {
    onFrameLoaded(index);
    const pct = 50 + Math.round(((index + 1) / enrichedScenes.length) * 45);
    onProgress({
      stage: 'storyboard',
      message: `${modeIcon} Generated scene ${index + 1} of ${enrichedScenes.length}`,
      progress: pct,
    });
  }, finalMemory, mode);

  // preloadImages is a no-op since images are base64 data URLs
  await preloadImages(frames, () => {});

  // ── Stage 5 (Optional): Veo Video Generation ─────────────────────────────
  if (useVeo) {
    onProgress({ stage: 'storyboard', message: '🎬 Starting Veo video generation…', progress: 98 });
    try {
      const { frames: veoFrames, failedScenes } = await runVeo(
        frames,
        (message, _pct) => {
          onProgress({ stage: 'storyboard', message, progress: 98 });
        },
      );
      if (failedScenes.length > 0) {
        console.warn('[Veo] Scenes using image fallback:', failedScenes);
      }
      onProgress({ stage: 'done', message: `✨ ${veoFrames.length} scenes ready with Veo video!`, progress: 100 });
      return veoFrames;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Veo] Stage failed entirely — returning images:', msg);
      onProgress({ stage: 'done', message: `⚠️ Veo failed, showing images instead. ${frames.length} scenes ready.`, progress: 100 });
    }
  }

  onProgress({ stage: 'done', message: `✨ ${frames.length} scenes ready!`, progress: 100 });

  return frames;
}
