// src/agents/storyboard.ts
// Agent 3 (V2.1): Storyboard Builder — Deterministic image generation
//
// V2.1 changes:
// - Image prompts are now compiled via `compileImagePrompt()` from memory.ts
// - Accepts optional StoryMemory for character injection
//
// V2.2 changes (mode-aware image routing):
// - animated mode  → existing Pollinations/HF pipeline via /api/imagen
// - documentary mode → Gemini native image generation via /api/gemini-image
//   Gemini produces photorealistic images well-suited to documentary visuals.
//   Falls back to Pollinations/HF automatically if Gemini image is unavailable.

import { Scene, StoryboardFrame, GenerationMode } from '../types';
import { generateImageWithImagen } from './imagen';
import { compileImagePrompt, StoryMemory } from './memory';

// ── Gemini image client ──────────────────────────────────────────────────────

/**
 * Generate a documentary image via Gemini's native image model.
 * Routed through the backend to keep the API key server-side.
 * Returns a base64 data URL.
 */
async function generateImageWithGemini(
  prompt: string,
  seed: number,
  mode: GenerationMode,
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  const res = await fetch(`${backendUrl}/api/gemini-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, seed, aspect_ratio: '16:9', mode }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini image backend error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('Gemini image returned no image data');
  return data.dataUrl;
}

// ── Image router ─────────────────────────────────────────────────────────────

/**
 * Select the appropriate image generator based on mode.
 *
 * animated    → Pollinations/HF (styled, anime-capable, cost-free)
 * documentary → Gemini native image (photorealistic, aligned with BBC/NatGeo style)
 *               Falls back to Pollinations/HF automatically via the backend.
 */
async function generateImage(
  prompt: string,
  apiKey: string,
  seed: number,
  mode: GenerationMode,
): Promise<string> {
  try {
    // Try high-quality Gemini Image generation first for ALL styles
    return await generateImageWithGemini(prompt, seed, mode);
  } catch (err) {
    console.warn(`Gemini image failed or blocked, falling back to Pollinations/HF:`, err);
    // Graceful fallback for safety filter blocks (violence/real people) or if key is missing
    return await generateImageWithImagen(prompt, apiKey, seed, mode);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runStoryboard(
  scenes: Scene[],
  globalSeed: number,
  apiKey: string,
  onImageReady: (index: number, frame: StoryboardFrame) => void,
  memory?: StoryMemory,
  mode: GenerationMode = 'animated',
): Promise<StoryboardFrame[]> {
  const results: StoryboardFrame[] = new Array(scenes.length);

  await Promise.all(
    scenes.map(async (scene, i) => {
      const seed = globalSeed + scene.scene_number;

      // V2.1: Deterministic prompt compilation with character memory + mode suffix
      const prompt = memory
        ? compileImagePrompt(scene, memory, mode)
        : [scene.visual_description, scene.style].filter(Boolean).join(', ');

      let mediaUrl = '';
      try {
        mediaUrl = await generateImage(prompt, apiKey, seed, mode);
      } catch (err) {
        console.warn(`Image generation failed for scene ${scene.scene_number}:`, err);
        mediaUrl = '';
      }

      const enrichedScene: Scene = { ...scene, seed, media_url: mediaUrl, media_type: 'image' };
      const frame: StoryboardFrame = {
        scene: enrichedScene,
        media_url: mediaUrl,
        media_type: 'image',
        mediaLoaded: false,
      };

      results[i] = frame;
      onImageReady(i, frame);
    }),
  );

  return results;
}

/** No-op preloader — images are already data URLs (base64), no HTTP preloading needed. */
export function preloadImages(
  frames: StoryboardFrame[],
  onImageLoad: (index: number) => void,
): Promise<void> {
  frames.forEach((_, i) => onImageLoad(i));
  return Promise.resolve();
}
