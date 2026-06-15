// src/agents/videographer.ts
// Agent 3: Uses Luma Dream Machine API to generate video clips

import { Scene, StoryboardFrame } from '../types';

const LUMA_API_BASE = 'https://api.lumalabs.ai/dream-machine/v1';

async function generateVideo(prompt: string, lumaKey: string): Promise<string> {
  // 1. Submit generation request
  const submitRes = await fetch(`${LUMA_API_BASE}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lumaKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ prompt }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Luma API error: ${err}`);
  }

  const { id } = await submitRes.json();

  // 2. Poll for completion
  return new Promise((resolve, reject) => {
    const pollId = setInterval(async () => {
      try {
        const pollRes = await fetch(`${LUMA_API_BASE}/generations/${id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${lumaKey}`,
            'Accept': 'application/json',
          },
        });
        
        if (!pollRes.ok) {
          clearInterval(pollId);
          reject(new Error(`Luma polling error: ${pollRes.statusText}`));
          return;
        }

        const data = await pollRes.json();
        
        if (data.state === 'completed') {
          clearInterval(pollId);
          if (data.assets && data.assets.video) {
            resolve(data.assets.video);
          } else {
            reject(new Error('Luma API completed but no video asset was found.'));
          }
        } else if (data.state === 'failed') {
          clearInterval(pollId);
          reject(new Error(data.failure_reason || 'Luma video generation failed.'));
        }
        // If state is 'queued' or 'dreaming', continue polling
      } catch (err) {
        clearInterval(pollId);
        reject(err);
      }
    }, 3000); // Poll every 3 seconds
  });
}

export async function runVideographer(
  scenes: Scene[],
  lumaKey: string,
  globalSeed: number,
  onProgress: (stage: 'storyboard', message: string, progress: number) => void
): Promise<StoryboardFrame[]> {
  onProgress('storyboard', `🎥 Luma AI is generating ${scenes.length} video clips in parallel... (This takes 1-3 minutes)`, 50);

  // Trigger all Luma generations in parallel
  const videoPromises = scenes.map(async (scene, i) => {
    const seed = globalSeed + scene.scene_number;
    const prompt = `${scene.visual_description}, ${scene.style}`;
    
    try {
      const mediaUrl = await generateVideo(prompt, lumaKey);
      const enrichedScene: Scene = { ...scene, seed, media_url: mediaUrl, media_type: 'video' as const };
      return {
        scene: enrichedScene,
        media_url: mediaUrl,
        media_type: 'video' as const,
        mediaLoaded: false,
      };
    } catch (err: any) {
      console.warn(`Luma generation failed for scene ${scene.scene_number}: ${err.message}`);
      // Fallback if Luma fails
      return {
        scene: { ...scene, seed, media_url: '', media_type: 'video' as const },
        media_url: '',
        media_type: 'video' as const,
        mediaLoaded: false,
      };
    }
  });

  const frames = await Promise.all(videoPromises);
  
  onProgress('storyboard', `✅ Downloaded ${frames.length} video clips from Luma!`, 95);
  return frames;
}
