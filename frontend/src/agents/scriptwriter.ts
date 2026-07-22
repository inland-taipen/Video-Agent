// src/agents/scriptwriter.ts
// Agent 1 (V2.1): Story Generator — Converts raw narrative → structured screenplay
//
// V2.1 changes:
// - Prompt now requests a top-level JSON OBJECT with "characters" + "scenes"
//   (V0 only requested a flat scenes array)
// - Parser extracts both characters and scenes from the response
// - Existing Scene interface is unchanged — backwards compatible

import { callLLM } from './llm';
import { Scene, StylePreset, STYLE_DESCRIPTIONS, GenerationMode } from '../types';
import type { CharacterMemory } from './memory';

// ── JSON Schema (embedded in prompt for Gemini) ─────────────────────────────

const SCHEMA = `
{
  "characters": {
    "<CharacterName>": {
      "appearance": "<physical traits: age, hair color, eye color, build>",
      "clothing": "<what they wear: outfit, accessories, colors>",
      "personality": "<2-3 personality keywords>",
      "relationships": ["<relationship to other characters>"],
      "weapons": ["<if applicable, empty array otherwise>"],
      "powers": ["<if applicable, empty array otherwise>"]
    }
  },
  "scenes": [
    {
      "scene_number": <integer starting at 1>,
      "setting": "<INT/EXT. LOCATION - TIME>",
      "narration": "<voiceover prose for this scene, 1-3 sentences>",
      "dialogue": [{"speaker": "<name>", "line": "<spoken text>"}],
      "transition": "<FADE IN | CUT TO | CROSSFADE | DISSOLVE>",
      "visual_description": "<vivid, camera-level description of exactly what is visible>",
      "sfx": "<ambient sound effect description, e.g. gentle rain, ocean waves, birds chirping, fireplace crackle, space hum>",
      "duration": <integer seconds, 3-8>
    }
  ]
}
`.trim();

// ── Prompt Builders (Strategy pattern — one per mode) ──────────────────────

function buildAnimatedPrompt(story: string, style: StylePreset, sceneCount: number): string {
  return `You are a master screenwriter crafting an emotionally engaging anime story.

Create an exactly ${sceneCount}-scene screenplay from the user's story. Each scene should advance the narrative and build emotional momentum.

Global art style: "${STYLE_DESCRIPTIONS[style]}"

Return ONLY a valid JSON object (no markdown, no prose, no code fences) matching this schema:
${SCHEMA}

Rules:
- Define ALL named characters in the "characters" object FIRST, before the scenes.
- Every character who speaks dialogue MUST appear in "characters".
- visual_description must be a concrete, camera-level description of what is visible: lighting, subjects, actions, background, facial expressions.
- CHARACTER CONSISTENCY: in every visual_description, refer to characters by name. The memory system will inject their physical descriptions automatically.
- PACING: build tension through the middle scenes. The final scene should deliver emotional resolution.
- CONTENT: keep all visual_descriptions wholesome and family-friendly. No violence, gore, weapons, horror imagery. Depict conflict gently.
- Incorporate the global art style into each visual_description.
- narration is voiceover text read aloud; it should flow naturally and cinematically.
- duration should reflect the scene's pacing: action = 3-4s, dialogue = 5-6s, emotional climax = 6-8s.

Story:
"""
${story}
"""`;
}

function buildDocumentaryPrompt(story: string, style: StylePreset, sceneCount: number): string {
  return `You are a professional documentary screenwriter in the style of BBC Earth and National Geographic.

Create an exactly ${sceneCount}-scene educational documentary screenplay from the user's topic. Each scene should educate and inspire the viewer.

Global visual style: "${STYLE_DESCRIPTIONS[style]}"

Return ONLY a valid JSON object (no markdown, no prose, no code fences) matching this schema:
${SCHEMA}

Rules:
- "characters" should be empty ({}) unless the topic requires historical figures, in which case define them factually.
- If the topic involves animals, wildlife, or recurring natural subjects, define them in "characters" for visual consistency.
- narration must be factual, educational, professional, and calm — like a BBC Earth voiceover.
- visual_description must describe real, beautiful, photorealistic scenes: wide landscapes, macro photography, drone shots, natural environments.
- EDUCATIONAL PROGRESSION: structure scenes from broad overview → specific detail → inspiring conclusion.
- SAFETY GUARDRAIL: if the topic involves conflict, war, disease, or violence, automatically redirect to the peaceful, educational angle (history, architecture, technology, conservation, biology) WITHOUT disturbing imagery. Never depict blood, injuries, death, gore, or suffering.
- dialogue should be empty ([]) unless using a narrator voice or an on-screen expert quote.
- duration should be calm and considered: establishing shots = 5-7s, detail scenes = 4-6s, conclusion = 6-8s.
- Incorporate the global visual style into each visual_description.

Topic:
"""
${story}
"""`;
}

function buildStorybookPrompt(story: string, style: StylePreset, sceneCount: number): string {
  return `You are a warm, gentle storyteller crafting a beautifully illustrated children's storybook.

Create an exactly ${sceneCount}-scene storybook from the user's story. Each scene should feel like a page from a treasured picture book — cozy, magical, and emotionally warm.

Global art style: "${STYLE_DESCRIPTIONS[style]}"

Return ONLY a valid JSON object (no markdown, no prose, no code fences) matching this schema:
${SCHEMA}

Rules:
- Define ALL named characters in the "characters" object FIRST. Characters should feel friendly, rounded, and lovable.
- narration must sound like a grandparent telling a bedtime story: poetic, gentle, with simple wonder. Use short, flowing sentences.
- visual_description must paint a soft, illustrated scene: warm lighting, cozy settings, expressive character faces, hand-painted textures, soft edges.
- PACING: build gently. Start with a cozy introduction, explore a small problem or adventure, resolve with warmth and a gentle lesson.
- CONTENT: strictly wholesome, family-friendly, and comforting. No conflict beyond gentle misunderstanding. Always resolve warmly.
- Characters should have round, friendly, expressive faces. Settings should be cozy: cottages, meadows, forests with friendly animals.
- duration: slow and gentle — 5-7s per scene. Let the reader breathe.
- dialogue: warm, simple, conversational. Characters speak with kindness and wonder.
- Incorporate the global art style into each visual_description.

Story:
"""
${story}
"""`;
}

function buildCinematicPrompt(story: string, style: StylePreset, sceneCount: number): string {
  return `You are a world-class screenwriter crafting a gripping cinematic short film in the style of analog film photography — moody, atmospheric, and visually striking.

Create an exactly ${sceneCount}-scene screenplay from the user's story. Each scene should feel like a frame from a powerful independent film: intimate, tension-filled, and visually arresting.

Global visual style: "${STYLE_DESCRIPTIONS[style] || 'cinematic analog film photography, high contrast, dramatic shadows, moody atmosphere, film grain, 35mm'}"

Return ONLY a valid JSON object (no markdown, no prose, no code fences) matching this schema:
${SCHEMA}

Rules:
- Define ALL named characters in "characters" FIRST. Characters should feel real, flawed, and layered — never cartoonish.
- narration must be sparse, literary, and atmospheric — like a film-noir voiceover. Short, evocative sentences. Let silences breathe.
- visual_description must be photorealistic and cinematic: describe exact framing, lighting conditions, shadows, textures, rain, smoke, neon reflections. Think analog photography — grain, high contrast, dramatic compositions.
- PACING: build tension slowly. Long establishing shots, intimate close-ups on faces and details. The finale should feel earned.
- VISUAL LANGUAGE: favor silhouettes, backlit subjects, wet surfaces reflecting light, low-key lighting (darkness with isolated pools of light), and expressive shadows.
- dialogue: sparse and loaded with subtext. Characters say less than they mean. Every word counts.
- duration: deliberate and slow — establishing shots 5-7s, intimate scenes 4-6s, climax 6-8s.
- Incorporate the analog film aesthetic throughout each visual_description.

Story:
"""
${story}
"""`;
}

function buildPrompt(story: string, style: StylePreset, mode: GenerationMode, sceneCount: number): string {
  if (mode === 'documentary') return buildDocumentaryPrompt(story, style, sceneCount);
  if (mode === 'storybook') return buildStorybookPrompt(story, style, sceneCount);
  if (mode === 'cinematic') return buildCinematicPrompt(story, style, sceneCount);
  return buildAnimatedPrompt(story, style, sceneCount);
}

// ── Response Parser ─────────────────────────────────────────────────────────

export interface StoryGeneratorResult {
  scenes: Scene[];
  characters: Record<string, Partial<CharacterMemory>>;
}

function safeParseResponse(text: string): StoryGeneratorResult | null {
  // Strip markdown code fences if present
  let clean = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();

  // Try parsing as a top-level object with "characters" + "scenes"
  try {
    // Extract the first JSON object
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed.scenes && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
        return {
          characters: parsed.characters ?? {},
          scenes: normalizeScenes(parsed.scenes),
        };
      }
    }
  } catch { /* fall through to array parsing */ }

  // Fallback: try parsing as a flat JSON array (V0 format, for robustness)
  try {
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          characters: {},
          scenes: normalizeScenes(parsed),
        };
      }
    }
  } catch { /* give up */ }

  return null;
}

function normalizeScenes(raw: Partial<Scene>[]): Scene[] {
  return raw.map((r, i) => ({
    scene_number: Number(r.scene_number ?? i + 1),
    setting: String(r.setting ?? 'EXT. UNKNOWN - DAY'),
    narration: String(r.narration ?? ''),
    dialogue: Array.isArray(r.dialogue) ? r.dialogue : [],
    transition: String(r.transition ?? 'CUT TO'),
    visual_description: String(r.visual_description ?? ''),
    shot_type: String(r.shot_type ?? 'WIDE'),
    camera_movement: String(r.camera_movement ?? 'STATIC'),
    duration: Number(r.duration ?? 4),
    style: String(r.style ?? ''),
    sfx: String(r.sfx ?? 'gentle ambiance'),
    seed: 0,
    media_url: '',
    media_type: 'video' as const,
  }));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runScriptwriter(
  story: string,
  apiKey: string,
  style: StylePreset,
  mode: GenerationMode = 'animated',
  sceneCount: number = 6,
): Promise<StoryGeneratorResult> {
  const prompt = buildPrompt(story, style, mode, sceneCount);
  const text = await callLLM(apiKey, prompt, true);
  const result = safeParseResponse(text);
  if (result) return result;

  // Retry without JSON mode (some providers don't support it well)
  const text2 = await callLLM(apiKey, prompt + '\n\nReturn ONLY the raw JSON object.', false);
  const result2 = safeParseResponse(text2);
  if (result2) return result2;

  throw new Error('Scriptwriter: could not parse story JSON after 2 attempts.');
}
