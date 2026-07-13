// src/agents/memory.ts
// Deterministic Character Memory Manager
//
// Extracts character definitions from the Story Generator's output and
// provides a lookup function for the Prompt Compiler. No LLM calls —
// pure data extraction and string assembly.

import { Scene } from '../types';
import type { GenerationMode } from '../types';

// ── Character Memory Schema ─────────────────────────────────────────────────

export interface CharacterMemory {
  appearance: string;
  clothing: string;
  personality: string;
  relationships: string[];
  weapons: string[];
  powers: string[];
}

export interface StoryMemory {
  characters: Record<string, CharacterMemory>;
  recurringLocations: string[];
  globalStyle: string;
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract character memory from the Story Generator's JSON response.
 *
 * The Story Generator is prompted to include a `characters` object in its
 * response. If it does, we use it directly. If it doesn't (fallback), we
 * parse character descriptions from the first `visual_description` in which
 * each unique speaker appears.
 */
export function extractMemory(
  scenes: Scene[],
  rawCharacters?: Record<string, Partial<CharacterMemory>>,
  globalStyle?: string,
): StoryMemory {
  const characters: Record<string, CharacterMemory> = {};

  // 1. Use explicit character definitions if the LLM provided them
  if (rawCharacters && Object.keys(rawCharacters).length > 0) {
    for (const [name, raw] of Object.entries(rawCharacters)) {
      characters[name] = {
        appearance: raw.appearance ?? '',
        clothing: raw.clothing ?? '',
        personality: raw.personality ?? '',
        relationships: raw.relationships ?? [],
        weapons: raw.weapons ?? [],
        powers: raw.powers ?? [],
      };
    }
  }

  // 2. Fallback: extract unique speaker names from dialogue and associate
  //    them with the visual_description of their first appearance
  const seenSpeakers = new Set(Object.keys(characters));
  for (const scene of scenes) {
    for (const line of scene.dialogue ?? []) {
      const speaker = line.speaker?.trim();
      if (speaker && !seenSpeakers.has(speaker)) {
        seenSpeakers.add(speaker);
        characters[speaker] = {
          appearance: scene.visual_description ?? '',
          clothing: '',
          personality: '',
          relationships: [],
          weapons: [],
          powers: [],
        };
      }
    }
  }

  // 3. Extract recurring locations from scene settings
  const locationCounts: Record<string, number> = {};
  for (const scene of scenes) {
    const loc = scene.setting?.replace(/^(INT|EXT)\.?\s*/i, '').trim();
    if (loc) locationCounts[loc] = (locationCounts[loc] ?? 0) + 1;
  }
  const recurringLocations = Object.entries(locationCounts)
    .filter(([, count]) => count > 1)
    .map(([loc]) => loc);

  return {
    characters,
    recurringLocations,
    globalStyle: globalStyle ?? '',
  };
}

// ── Mode Quality Suffixes ───────────────────────────────────────────────────
// All mode-specific image quality tokens live here — single place to update.

const MODE_QUALITY_SUFFIX: Record<GenerationMode, string[]> = {
  animated: [
    'anime', '2D illustration', 'masterpiece', 'highly detailed',
    'cinematic', 'vibrant colors', 'dramatic lighting', 'expressive characters',
  ],
  documentary: [
    'professional wildlife photography', 'National Geographic', 'BBC Earth',
    'photorealistic', 'natural lighting', '8K', 'cinematic documentary',
    'high detail', 'beautiful composition', 'safe educational imagery',
  ],
  storybook: [
    "children's book illustration", 'soft watercolor', 'Beatrix Potter style',
    'warm pastel colors', 'hand-painted', 'cozy and whimsical', 'gentle storybook',
    'family-friendly', 'soft warm light', 'beautifully illustrated',
  ],
};

// ── Prompt Compilation ───────────────────────────────────────────────────────

/**
 * Deterministic image prompt compiler.
 *
 * Assembles a final image prompt from:
 *   [global_style] + [character_descriptions] + [scene_visual] +
 *   [camera_details] + [quality_modifiers]
 *
 * This runs in ~0ms with zero API cost and guarantees the exact same
 * character tokens appear in every scene, preventing visual drift.
 */
export function compileImagePrompt(
  scene: Scene,
  memory: StoryMemory,
  mode: GenerationMode = 'animated',
): string {
  const parts: string[] = [];

  // 1. Global art style (if the Visual Director set one)
  if (memory.globalStyle) {
    parts.push(memory.globalStyle);
  }

  // 2. Scene visual style (from Visual Director enrichment)
  if (scene.style) {
    parts.push(scene.style);
  }

  // 3. Character descriptions — inject from memory for consistency
  //    Documentary mode naturally has sparse character definitions;
  //    this block still runs and simply finds no matches, which is correct.
  const activeChars = findActiveCharacters(scene, memory);
  for (const name of activeChars) {
    const char = memory.characters[name];
    if (char) {
      const desc = [char.appearance, char.clothing]
        .filter(Boolean)
        .join(', ');
      if (desc) parts.push(`${name} (${desc})`);
    }
  }

  // 4. Scene visual description (the creative core from the LLM)
  if (scene.visual_description) {
    parts.push(scene.visual_description);
  }

  // 5. Camera & composition details
  if (scene.shot_type && scene.shot_type !== 'WIDE') {
    parts.push(`${scene.shot_type.toLowerCase()} shot`);
  }

  // 6. Mode-specific quality modifiers
  parts.push(...MODE_QUALITY_SUFFIX[mode]);

  return parts.filter(Boolean).join(', ');
}

/**
 * Find which characters from memory are active in this scene.
 * Checks dialogue speakers and scans visual_description for name mentions.
 */
function findActiveCharacters(scene: Scene, memory: StoryMemory): string[] {
  const names = Object.keys(memory.characters);
  if (names.length === 0) return [];

  const active = new Set<string>();

  // From dialogue speakers
  for (const line of scene.dialogue ?? []) {
    const speaker = line.speaker?.trim();
    if (speaker && names.includes(speaker)) {
      active.add(speaker);
    }
  }

  // From visual description text (case-insensitive scan)
  const desc = (scene.visual_description ?? '').toLowerCase();
  for (const name of names) {
    if (desc.includes(name.toLowerCase())) {
      active.add(name);
    }
  }

  return [...active];
}
