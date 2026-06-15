// src/agents/scriptwriter.ts
// Agent 1: Converts raw narrative → structured Scene[] using Gemini

import { callLLM } from './llm';
import { Scene, StylePreset, STYLE_DESCRIPTIONS } from '../types';

const SCHEMA = `
{
  "scene_number": <integer starting at 1>,
  "setting": "<INT/EXT. LOCATION - TIME>",
  "narration": "<voiceover prose for this scene, 1-3 sentences>",
  "dialogue": [{"speaker": "<name>", "line": "<spoken text>"}],
  "transition": "<FADE IN | CUT TO | CROSSFADE | DISSOLVE>",
  "visual_description": "<vivid, camera-level description of exactly what is visible>"
}
`.trim();

function buildPrompt(story: string, style: StylePreset): string {
  return `You are a professional screenwriter.

Break the following story into 4-8 cinematic scenes suitable for a storyboard video.
Global art style: "${STYLE_DESCRIPTIONS[style]}"

Return ONLY a valid JSON array (no markdown, no prose, no code fences) where each element matches:
${SCHEMA}

Rules:
- Every field must be present. Never leave a field empty.
- visual_description must be a concrete, camera-level description of what is visible: lighting, subjects, actions, background.
- Incorporate the global art style into each visual_description.
- narration is the voiceover text read aloud; it should flow naturally.

Story:
"""
${story}
"""`;
}

function safeParseScenes(text: string): Scene[] | null {
  // Strip markdown code fences if present
  let clean = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  // Extract the first JSON array
  const m = clean.match(/\[[\s\S]*\]/);
  if (m) clean = m[0];
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((raw: Partial<Scene>, i: number) => ({
        scene_number: Number(raw.scene_number ?? i + 1),
        setting: String(raw.setting ?? 'EXT. UNKNOWN - DAY'),
        narration: String(raw.narration ?? ''),
        dialogue: Array.isArray(raw.dialogue) ? raw.dialogue : [],
        transition: String(raw.transition ?? 'CUT TO'),
        visual_description: String(raw.visual_description ?? ''),
        shot_type: String(raw.shot_type ?? 'WIDE'),
        camera_movement: String(raw.camera_movement ?? 'STATIC'),
        duration: Number(raw.duration ?? 3),
        style: String(raw.style ?? ''),
        seed: 0,
        media_url: '',
        media_type: 'video',
      }));
    }
  } catch {}
  return null;
}

export async function runScriptwriter(
  story: string,
  apiKey: string,
  style: StylePreset,
): Promise<Scene[]> {
  const prompt = buildPrompt(story, style);
  const text = await callLLM(apiKey, prompt, true);
  const scenes = safeParseScenes(text);
  if (!scenes) {
    // Retry without JSON mode
    const text2 = await callLLM(apiKey, prompt + '\n\nReturn ONLY the raw JSON array.', false);
    const scenes2 = safeParseScenes(text2);
    if (!scenes2) throw new Error('Scriptwriter: could not parse scene JSON from Llama 3 after 2 attempts.');
    return scenes2;
  }
  return scenes;
}
