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

import { Scene, StoryboardFrame, GenerationMode, StylePreset } from '../types';
import { generateImageWithImagen } from './imagen';
import { compileImagePrompt, StoryMemory } from './memory';

// Style mappings for Stable Horde model selection
const HORDE_ANIME_STYLES: StylePreset[] = ['Anime', 'Realistic Anime'];
const HORDE_CINEMATIC_STYLES: StylePreset[] = ['Cinematic', 'Noir', 'Dynamic', 'Photorealistic'];
const HORDE_STYLED: StylePreset[] = [...HORDE_ANIME_STYLES, ...HORDE_CINEMATIC_STYLES, 'Sci-Fi', 'Fantasy', 'Documentary'];

// ── Stable Horde image client ──────────────────────────────────────────────

/**
 * Generate an image via Stable Horde (free community GPU pool).
 * Backend handles model selection and polling. Returns a base64 data URL.
 */
async function generateImageWithHorde(
  prompt: string,
  seed: number,
  style: StylePreset,
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // Map StylePreset to Horde model category
  let hordeStyle = 'default';
  if (HORDE_ANIME_STYLES.includes(style)) hordeStyle = style === 'Realistic Anime' ? 'realistic_anime' : 'anime';
  else if (HORDE_CINEMATIC_STYLES.includes(style)) hordeStyle = 'cinematic';
  else if (style === 'Fantasy' || style === 'Sci-Fi') hordeStyle = 'fantasy';
  else if (style === 'Documentary') hordeStyle = 'documentary';

  const res = await fetch(`${backendUrl}/api/horde-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, seed, aspect_ratio: '16:9', style: hordeStyle }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Horde backend error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('Horde returned no image data');
  return data.dataUrl;
}

// ── Leonardo AI image client (fallback) ──────────────────────────────────

/**
 * Generate a high-quality image via Leonardo AI through the backend proxy.
 * The backend handles: Leonardo -> FLUX -> Gemini -> Pollinations waterfall.
 * Returns a base64 data URL.
 */
async function generateImageWithLeonardo(
  prompt: string,
  seed: number,
  style: StylePreset,
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // Map StylePreset to Leonardo model category
  let leonardoStyle = 'default';
  if (LEONARDO_ANIME_STYLES.includes(style)) leonardoStyle = 'anime';
  else if (LEONARDO_CINEMATIC_STYLES.includes(style)) leonardoStyle = 'cinematic';
  else if (style === 'Sci-Fi' || style === 'Fantasy') leonardoStyle = 'flux';

  const res = await fetch(`${backendUrl}/api/leonardo-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, seed, aspect_ratio: '16:9', style: leonardoStyle }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Leonardo backend error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('Leonardo returned no image data');
  return data.dataUrl;
}

// ── FLUX image client (fal.ai) ───────────────────────────────────────────────

/**
 * Generate a high-quality image via FLUX.1 through the backend proxy.
 * Returns a base64 data URL.
 */
async function generateImageWithFlux(
  prompt: string,
  seed: number,
  model: 'dev' | 'schnell' = 'dev',
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  const res = await fetch(`${backendUrl}/api/flux-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, seed, aspect_ratio: '16:9', model }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`FLUX backend error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('FLUX returned no image data');
  return data.dataUrl;
}

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
 * Waterfall image generation:
 *   1. Stable Horde (free, community GPU, Anime/DreamShaper/Realistic Vision models)
 *   2. Leonardo AI (fallback if Horde unavailable)
 *   3. Gemini image (photorealistic fallback)
 *   4. Pollinations/HF (free-tier last resort)
 */
async function generateImage(
  prompt: string,
  apiKey: string,
  seed: number,
  mode: GenerationMode,
  style?: StylePreset,
): Promise<string> {
  const effectiveStyle = style ?? 'default' as StylePreset;

  // Primary: Stable Horde — free, no card, great anime quality
  try {
    return await generateImageWithHorde(prompt, seed, effectiveStyle);
  } catch (err) {
    console.warn('Horde failed, trying Leonardo:', err);
  }

  // Secondary: Leonardo AI (if key is set)
  if (style && HORDE_STYLED.includes(style)) {
    try {
      return await generateImageWithLeonardo(prompt, seed, style);
    } catch (err) {
      console.warn('Leonardo failed, trying Gemini:', err);
    }
  }

  // Gemini — great for photorealistic / documentary
  try {
    return await generateImageWithGemini(prompt, seed, mode);
  } catch (err) {
    console.warn('Gemini image failed, falling back to Pollinations/HF:', err);
  }

  // Last resort
  return await generateImageWithImagen(prompt, apiKey, seed, mode);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runStoryboard(
  scenes: Scene[],
  globalSeed: number,
  apiKey: string,
  onImageReady: (index: number, frame: StoryboardFrame) => void,
  memory?: StoryMemory,
  mode: GenerationMode = 'animated',
  style?: StylePreset,
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
        mediaUrl = await generateImage(prompt, apiKey, seed, mode, style);
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
