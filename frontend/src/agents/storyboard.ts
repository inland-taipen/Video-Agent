// src/agents/storyboard.ts
// Agent 3: Generates images with Imagen 3 (Google), assigns seeds, returns StoryboardFrame[]

import { Scene, StoryboardFrame } from '../types';
import { generateImageWithImagen } from './imagen';

export async function runStoryboard(
  scenes: Scene[],
  globalSeed: number,
  apiKey: string,
  onImageReady: (index: number, frame: StoryboardFrame) => void,
): Promise<StoryboardFrame[]> {
  const results: StoryboardFrame[] = new Array(scenes.length);

  await Promise.all(
    scenes.map(async (scene, i) => {
      const seed = globalSeed + scene.scene_number;
      const prompt = [scene.visual_description, scene.style].filter(Boolean).join(', ');

      let mediaUrl = '';
      try {
        mediaUrl = await generateImageWithImagen(prompt, apiKey);
      } catch (err) {
        console.warn(`Imagen 3 failed for scene ${scene.scene_number}:`, err);
        // Fallback: blank placeholder so the pipeline doesn't crash
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
