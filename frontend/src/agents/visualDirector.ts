// src/agents/visualDirector.ts
// Agent 2: Enriches Scene[] with shot_type, camera_movement, duration, style

import { callLLM } from './llm';
import { Scene, StylePreset, STYLE_DESCRIPTIONS } from '../types';

const ENRICHED_SCHEMA = `
{
  "scene_number": <same integer as input>,
  "shot_type": "<EXTREME WIDE | WIDE | MEDIUM | CLOSE-UP | EXTREME CLOSE-UP | POV>",
  "camera_movement": "<STATIC | ZOOM IN | ZOOM OUT | PAN LEFT | PAN RIGHT | PAN UP | PAN DOWN>",
  "duration": <integer seconds, 2-6>,
  "style": "<global visual style string, consistent across all scenes>"
}
`.trim();

function buildPrompt(scenes: Scene[], style: StylePreset): string {
  const sceneList = scenes
    .map(
      (s) =>
        `Scene ${s.scene_number}:\n  Setting: ${s.setting}\n  Action: ${s.visual_description}`,
    )
    .join('\n\n');

  return `You are a visual director for a storyboard video.

Global art style: "${STYLE_DESCRIPTIONS[style]}"

For each scene below, choose:
- The best cinematic shot type
- The best camera movement to match the emotional tone
- An appropriate duration (action = shorter, dialogue = longer)
- A concise global style string consistent across all scenes

Return ONLY a valid JSON array (no markdown, no prose) where each element matches:
${ENRICHED_SCHEMA}

Scenes:
${sceneList}`;
}

export async function runVisualDirector(
  scenes: Scene[],
  apiKey: string,
  style: StylePreset,
): Promise<Scene[]> {
  const prompt = buildPrompt(scenes, style);
  const text = await callLLM(apiKey, prompt, true);

  let enrichments: Partial<Scene>[] = [];
  try {
    let clean = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) clean = m[0];
    enrichments = JSON.parse(clean);
  } catch {
    console.warn('VisualDirector: Could not parse enrichment JSON, using defaults');
    return scenes; // graceful fallback
  }

  // Merge enrichments back into scenes
  return scenes.map((scene) => {
    const e = enrichments.find((x) => x.scene_number === scene.scene_number) ?? {};
    return {
      ...scene,
      shot_type: String(e.shot_type ?? scene.shot_type ?? 'WIDE'),
      camera_movement: String(e.camera_movement ?? 'STATIC'),
      duration: Number(e.duration ?? scene.duration ?? 3),
      style: String(e.style ?? STYLE_DESCRIPTIONS[style]),
    };
  });
}
