// src/agents/visualDirector.ts
// Agent 2 (V2.1): Visual Director — Enriches scenes with cinematic direction
//
// V2.1 changes:
// - Prompt now requests richer visual fields: lighting, atmosphere, color_palette,
//   composition, cinematic_style (V0 only asked for shot_type, camera_movement,
//   duration, style)
// - These extra fields are stored on the Scene's `style` field as a compiled
//   string, since adding new fields to Scene would break all downstream
//   components (StoryboardGrid, CanvasPlayer, ExportPanel, compiler.py)
// - Existing Scene interface is unchanged — backwards compatible

import { callLLM } from './llm';
import { Scene, StylePreset, STYLE_DESCRIPTIONS, GenerationMode } from '../types';

// ── JSON Schema ─────────────────────────────────────────────────────────────

const ENRICHED_SCHEMA = `
{
  "scene_number": <same integer as input>,
  "shot_type": "<EXTREME WIDE | WIDE | MEDIUM | CLOSE-UP | EXTREME CLOSE-UP | POV>",
  "camera_movement": "<STATIC | ZOOM IN | ZOOM OUT | PAN LEFT | PAN RIGHT | PAN UP | PAN DOWN>",
  "duration": <integer seconds, 3-8>,
  "lighting": "<e.g., golden hour, moonlight, candlelight, neon glow>",
  "atmosphere": "<e.g., melancholic, triumphant, tense, peaceful>",
  "color_palette": "<e.g., warm oranges and deep purples, cool blues and silver>",
  "composition": "<e.g., rule of thirds with subject left, centered symmetrical, diagonal leading lines>",
  "cinematic_style": "<a concise visual style string consistent across all scenes>"
}
`.trim();

// ── Prompt Builders (Strategy pattern — one per mode) ──────────────────────

function buildAnimatedPrompt(scenes: Scene[], style: StylePreset): string {
  const sceneList = scenes
    .map(
      (s) =>
        `Scene ${s.scene_number}:\n  Setting: ${s.setting}\n  Action: ${s.visual_description}\n  Narration: ${s.narration}`,
    )
    .join('\n\n');

  return `You are a world-class cinematographer and visual director for an anime storyboard.

Global art style: "${STYLE_DESCRIPTIONS[style]}"

For each scene below, design the complete visual treatment:
- Shot type that best frames the emotional beat
- Camera movement that matches the scene's energy (use dynamic movements: ZOOM IN, ZOOM OUT, PAN)
- Duration (action = 3-4s, dialogue = 5-6s, emotional moments = 6-8s)
- Lighting that enhances mood (dramatic, high-contrast, expressive)
- Atmosphere keywords (melancholic, triumphant, tense, hopeful)
- Color palette (vibrant, saturated, dramatic gradients)
- Composition following anime cinematographic principles
- A concise cinematic_style string consistent across ALL scenes

Return ONLY a valid JSON array (no markdown, no prose) where each element matches:
${ENRICHED_SCHEMA}

Rules:
- cinematic_style MUST be identical across all scenes to maintain visual consistency.
- lighting should be expressive and dramatic, matching the emotional tone.
- atmosphere should reflect the story's emotional progression.

Scenes:
${sceneList}`;
}

function buildDocumentaryPrompt(scenes: Scene[], style: StylePreset): string {
  const sceneList = scenes
    .map(
      (s) =>
        `Scene ${s.scene_number}:\n  Setting: ${s.setting}\n  Subject: ${s.visual_description}\n  Narration: ${s.narration}`,
    )
    .join('\n\n');

  return `You are a world-class documentary cinematographer in the style of BBC Earth and National Geographic.

Global visual style: "${STYLE_DESCRIPTIONS[style]}"

For each scene below, design the complete cinematic treatment:
- Shot type best suited for documentary storytelling (prefer WIDE, EXTREME WIDE, CLOSE-UP for detail)
- Camera movement appropriate for a calm, professional documentary (prefer STATIC, slow PAN, drone-like movements)
- Duration (establishing shots = 5-7s, detail scenes = 4-6s, closing = 6-8s)
- Lighting that is natural, beautiful, and realistic (golden hour, soft diffused daylight, moonlight)
- Atmosphere keywords (awe-inspiring, serene, contemplative, majestic)
- Color palette (natural earth tones, rich blues and greens, warm golden hues)
- Composition following professional documentary/photography principles (rule of thirds, leading lines, foreground depth)
- A concise cinematic_style that is CONSISTENT across ALL scenes and evokes BBC Earth / National Geographic

Return ONLY a valid JSON array (no markdown, no prose) where each element matches:
${ENRICHED_SCHEMA}

Rules:
- cinematic_style MUST be identical across all scenes.
- NEVER suggest disturbing, violent, or graphic visual content. If a scene implies danger, frame it from a safe, observational distance.
- All imagery must be beautiful, natural, and safe for general audiences.
- lighting should be natural and photorealistic.

Scenes:
${sceneList}`;
}

function buildStorybookPrompt(scenes: Scene[], style: StylePreset): string {
  const sceneList = scenes
    .map(
      (s) =>
        `Scene ${s.scene_number}:\n  Setting: ${s.setting}\n  Action: ${s.visual_description}\n  Narration: ${s.narration}`,
    )
    .join('\n\n');

  return `You are a gentle art director for a beautifully illustrated children's picture book.

Global art style: "${STYLE_DESCRIPTIONS[style]}"

For each scene below, design the complete visual treatment for a soft, illustrated storybook page:
- Shot type: prefer MEDIUM and CLOSE-UP to show character expressions warmly
- Camera movement: mostly STATIC or gentle ZOOM IN — slow and peaceful
- Duration: gentle pacing, 5-7s per scene
- Lighting: always warm and soft — golden sunlight, candlelight, cozy fireplace, morning glow
- Atmosphere: cozy, warm, magical, gentle, whimsical, hopeful
- Color palette: warm pastels — peach, soft pink, sage green, cream, lavender, warm gold
- Composition: centered or slightly off-center, with breathing room. Characters are always the warm focus.
- A concise cinematic_style string consistent across ALL scenes (e.g. “soft watercolor illustration, warm light, storybook page”)

Return ONLY a valid JSON array (no markdown, no prose) where each element matches:
${ENRICHED_SCHEMA}

Rules:
- cinematic_style MUST be identical across all scenes.
- Every scene must feel safe, cozy, and warm. No dark or threatening atmospheres.
- STATIC or gentle ZOOM IN movements only — never jarring cuts.

Scenes:
${sceneList}`;
}

function buildCinematicPrompt(scenes: Scene[], style: StylePreset): string {
  const sceneList = scenes
    .map(
      (s) =>
        `Scene ${s.scene_number}:\n  Setting: ${s.setting}\n  Action: ${s.visual_description}\n  Narration: ${s.narration}`,
    )
    .join('\n\n');

  return `You are a world-class cinematographer for a gritty analog-film feature — think Tarkovsky, Wong Kar-wai, and neo-noir.

Global visual style: "${STYLE_DESCRIPTIONS[style]}"

For each scene, design the complete cinematic treatment:
- Shot type that maximizes visual tension (EXTREME CLOSE-UP for emotion, WIDE for isolation, LOW ANGLE for power)
- Camera movement: deliberate and sparse — prefer STATIC, slow ZOOM IN, or heavy PAN
- Duration: slow and considered (establishing shots 5-7s, intimate scenes 4-6s, climax 6-8s)
- Lighting: chiaroscuro — deep shadows, isolated pools of light, neon reflections on rain, candlelight, harsh street lamps
- Atmosphere keywords: desolate, tense, melancholic, haunting, brooding, intimate
- Color palette: muted and film-grain — desaturated greens and blues, amber highlights, silver moonlight, deep blacks
- Composition: high contrast, rule of thirds broken for unease, subjects silhouetted or half-lit
- A concise cinematic_style consistent across ALL scenes that captures the analog film grain and noir mood

Return ONLY a valid JSON array (no markdown, no prose) where each element matches:
${ENRICHED_SCHEMA}

Rules:
- cinematic_style MUST be identical across all scenes.
- lighting should be low-key: darkness dominates, light is the exception.
- atmosphere should feel real, heavy, and human.

Scenes:
${sceneList}`;
}

function buildPrompt(scenes: Scene[], style: StylePreset, mode: GenerationMode): string {
  if (mode === 'documentary') return buildDocumentaryPrompt(scenes, style);
  if (mode === 'storybook') return buildStorybookPrompt(scenes, style);
  if (mode === 'cinematic') return buildCinematicPrompt(scenes, style);
  return buildAnimatedPrompt(scenes, style);
}

// ── Enrichment Types ────────────────────────────────────────────────────────

interface VisualEnrichment {
  scene_number?: number;
  shot_type?: string;
  camera_movement?: string;
  duration?: number;
  lighting?: string;
  atmosphere?: string;
  color_palette?: string;
  composition?: string;
  cinematic_style?: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface VisualDirectorResult {
  scenes: Scene[];
  globalStyle: string;
}

export async function runVisualDirector(
  scenes: Scene[],
  apiKey: string,
  style: StylePreset,
  mode: GenerationMode = 'animated',
): Promise<VisualDirectorResult> {
  const prompt = buildPrompt(scenes, style, mode);
  const text = await callLLM(apiKey, prompt, true);

  let enrichments: VisualEnrichment[] = [];
  try {
    let clean = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) clean = m[0];
    enrichments = JSON.parse(clean);
  } catch {
    console.warn('VisualDirector: Could not parse enrichment JSON, using defaults');
    return {
      scenes,
      globalStyle: STYLE_DESCRIPTIONS[style],
    };
  }

  // Extract the global cinematic style from the first enrichment that has one
  const globalStyle = enrichments.find((e) => e.cinematic_style)?.cinematic_style
    ?? STYLE_DESCRIPTIONS[style];

  // Merge enrichments back into scenes
  const enrichedScenes = scenes.map((scene) => {
    const e = enrichments.find((x) => x.scene_number === scene.scene_number) ?? {};

    // Compile the rich visual fields into the `style` string.
    // This preserves the Scene interface while carrying extra context
    // to the Prompt Compiler in storyboard.ts.
    const styleParts = [
      e.cinematic_style ?? globalStyle,
      e.lighting ? `${e.lighting} lighting` : '',
      e.atmosphere ? `${e.atmosphere} atmosphere` : '',
      e.color_palette ? `${e.color_palette}` : '',
      e.composition ? `${e.composition}` : '',
    ].filter(Boolean);

    return {
      ...scene,
      shot_type: String(e.shot_type ?? scene.shot_type ?? 'WIDE'),
      camera_movement: String(e.camera_movement ?? scene.camera_movement ?? 'STATIC'),
      duration: Number(e.duration ?? scene.duration ?? 4),
      style: styleParts.join(', '),
    };
  });

  return {
    scenes: enrichedScenes,
    globalStyle,
  };
}
