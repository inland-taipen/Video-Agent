// src/agents/storyboard.ts
// Agent 3: Pure logic — builds Pollinations image URLs, assigns seeds, returns StoryboardFrame[]

import { Scene, StoryboardFrame } from '../types';

// Use Vite dev proxy (/api → backend) so images load same-origin in the browser.
const IMAGE_API_BASE = '/api/image';

function buildImageUrl(visualDescription: string, style: string, seed: number): string {
  const fullPrompt = [visualDescription, style].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    prompt: fullPrompt,
    seed: String(seed),
    width: '1024',
    height: '576',
  });
  return `${IMAGE_API_BASE}?${params}`;
}

export function runStoryboard(scenes: Scene[], globalSeed: number): StoryboardFrame[] {
  return scenes.map((scene) => {
    const seed = globalSeed + scene.scene_number;
    const imageUrl = buildImageUrl(scene.visual_description, scene.style, seed);
    const enrichedScene: Scene = { ...scene, seed, media_url: imageUrl, media_type: 'image' };
    return {
      scene: enrichedScene,
      media_url: imageUrl,
      media_type: 'image',
      mediaLoaded: false,
    };
  });
}

export function preloadImages(
  frames: StoryboardFrame[],
  onImageLoad: (index: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let currentIndex = 0;

    function loadNext() {
      if (currentIndex >= frames.length) {
        resolve();
        return;
      }
      const i = currentIndex;
      const frame = frames[i];

      const img = new Image();

      const handleDone = () => {
        onImageLoad(i);
        currentIndex++;
        loadNext();
      };

      img.onload = handleDone;
      img.onerror = handleDone;
      img.src = frame.media_url;
    }

    loadNext();
  });
}
