// src/agents/veo.ts
// Veo video generation agent — calls backend /api/veo endpoint.
// The backend handles Veo API polling and returns a base64 data URL.

import { Scene, StoryboardFrame } from '../types';

const VEO_DURATION_SECONDS = 30; // 30-second video clips

/**
 * Generate a single video clip for a scene via Veo.
 * Returns a base64 data URL (data:video/mp4;base64,...) on success.
 * Throws on failure — caller should fall back to image.
 */
async function generateVideoWithVeo(prompt: string, seed: number): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

  // Add seed to prompt for variety
  const enrichedPrompt = prompt; // seed is deterministic on the backend side

  const res = await fetch(`${backendUrl}/api/veo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: enrichedPrompt,
      duration_seconds: VEO_DURATION_SECONDS,
      aspect_ratio: '16:9',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Veo backend error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('Veo returned no video data');
  return data.dataUrl;
}

export interface VeoResult {
  frames: StoryboardFrame[];
  failedScenes: number[]; // scene_numbers that fell back to images
}

/**
 * Run Veo video generation for all scenes.
 * Scenes are processed sequentially (not parallel) to avoid overloading the API.
 * Falls back to the existing image URL if Veo fails for a scene.
 */
export async function runVeo(
  imageFrames: StoryboardFrame[],  // frames already have images as fallback
  onProgress: (message: string, progress: number) => void,
): Promise<VeoResult> {
  const frames: StoryboardFrame[] = [...imageFrames];
  const failedScenes: number[] = [];
  const total = imageFrames.length;

  onProgress(`🎬 Generating ${total} Veo video clips (30s each)…`, 5);

  for (let i = 0; i < total; i++) {
    const frame = imageFrames[i];
    const scene = frame.scene;
    const pct = Math.round(10 + ((i / total) * 85));

    onProgress(
      `🎬 Veo: generating scene ${scene.scene_number} of ${total}…`,
      pct,
    );

    const prompt = [
      scene.visual_description,
      scene.style,
      scene.setting,
    ].filter(Boolean).join(', ');

    try {
      const videoUrl = await generateVideoWithVeo(prompt, scene.seed);
      const enrichedScene: Scene = {
        ...scene,
        media_url: videoUrl,
        media_type: 'video',
      };
      frames[i] = {
        ...frame,
        scene: enrichedScene,
        media_url: videoUrl,
        media_type: 'video',
        mediaLoaded: false,
      };
      console.log(`  [Veo] Scene ${scene.scene_number} → video OK`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [Veo] Scene ${scene.scene_number} failed: ${msg} — keeping image fallback`);
      failedScenes.push(scene.scene_number);
      // Keep existing image frame unchanged
    }
  }

  const succeeded = total - failedScenes.length;
  onProgress(
    `✅ Veo done — ${succeeded}/${total} video clips generated${failedScenes.length > 0 ? ` (${failedScenes.length} used image fallback)` : ''}`,
    100,
  );

  return { frames, failedScenes };
}
