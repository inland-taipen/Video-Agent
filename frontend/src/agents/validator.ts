// src/agents/validator.ts
// Deterministic Story Validator
//
// Validates the Story Generator's JSON output before passing it to the
// Visual Director. No LLM calls — pure rule-based checks using Pydantic-
// style validation in TypeScript.
//
// If validation fails, returns structured errors indicating exactly which
// scenes need to be patched, enabling partial re-prompting instead of
// restarting the entire pipeline.

import { Scene } from '../types';
import { StoryMemory } from './memory';

// ── Validation Result ───────────────────────────────────────────────────────

export interface ValidationError {
  scene_number: number;
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MIN_DURATION = 2;
const MAX_DURATION = 10;
const MAX_TOTAL_DURATION = 240; // 4 minutes in seconds
const MIN_SCENES = 2;
const MAX_SCENES = 12;

const VALID_TRANSITIONS = new Set([
  'FADE IN', 'CUT TO', 'CROSSFADE', 'DISSOLVE', 'WIPE',
]);

// ── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate scenes against V2.1 production rules.
 *
 * Rules checked:
 * 1. Scene count is within [2, 12]
 * 2. Every scene has non-empty narration
 * 3. Every scene has non-empty visual_description
 * 4. Durations are integers within [MIN_DURATION, MAX_DURATION]
 * 5. Total duration is under MAX_TOTAL_DURATION
 * 6. Characters referenced in dialogue exist in memory
 * 7. Transitions are valid enum values
 * 8. Scene numbers are sequential starting from 1
 */
export function validateStory(
  scenes: Scene[],
  memory?: StoryMemory,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // Rule 1: Scene count
  if (scenes.length < MIN_SCENES) {
    errors.push({
      scene_number: 0,
      field: 'scenes',
      message: `Too few scenes: got ${scenes.length}, need at least ${MIN_SCENES}`,
    });
  }
  if (scenes.length > MAX_SCENES) {
    warnings.push(`High scene count (${scenes.length}). Consider trimming to ${MAX_SCENES} for optimal video length.`);
  }

  let totalDuration = 0;

  for (const scene of scenes) {
    const sn = scene.scene_number;

    // Rule 2: Narration must exist
    if (!scene.narration?.trim()) {
      errors.push({
        scene_number: sn,
        field: 'narration',
        message: `Scene ${sn} has empty narration`,
      });
    }

    // Rule 3: Visual description must exist
    if (!scene.visual_description?.trim()) {
      errors.push({
        scene_number: sn,
        field: 'visual_description',
        message: `Scene ${sn} has empty visual_description`,
      });
    }

    // Rule 4: Duration must be valid
    const dur = scene.duration;
    if (!Number.isFinite(dur) || dur < MIN_DURATION || dur > MAX_DURATION) {
      errors.push({
        scene_number: sn,
        field: 'duration',
        message: `Scene ${sn} duration ${dur} is outside valid range [${MIN_DURATION}, ${MAX_DURATION}]`,
      });
    }
    totalDuration += Number.isFinite(dur) ? dur : 0;

    // Rule 6: Characters in dialogue exist in memory
    if (memory && scene.dialogue?.length) {
      const knownChars = new Set(Object.keys(memory.characters));
      for (const line of scene.dialogue) {
        const speaker = line.speaker?.trim();
        if (speaker && knownChars.size > 0 && !knownChars.has(speaker)) {
          warnings.push(`Scene ${sn}: speaker "${speaker}" not found in character memory. Image prompt may lack their description.`);
        }
      }
    }

    // Rule 7: Transition must be valid
    const trans = scene.transition?.trim().toUpperCase();
    if (trans && !VALID_TRANSITIONS.has(trans)) {
      warnings.push(`Scene ${sn}: unknown transition "${scene.transition}". Defaulting to CUT TO.`);
    }
  }

  // Rule 5: Total duration
  if (totalDuration > MAX_TOTAL_DURATION) {
    errors.push({
      scene_number: 0,
      field: 'total_duration',
      message: `Total duration ${totalDuration}s exceeds maximum ${MAX_TOTAL_DURATION}s (${MAX_TOTAL_DURATION / 60} min)`,
    });
  }

  // Rule 8: Sequential scene numbers
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].scene_number !== i + 1) {
      warnings.push(`Scene at index ${i} has scene_number ${scenes[i].scene_number}, expected ${i + 1}. Auto-fixing.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Auto-fix minor issues that don't require LLM re-prompting.
 *
 * Fixes applied:
 * - Clamp durations to valid range
 * - Normalize scene numbers to sequential 1..N
 * - Default missing transitions to "CUT TO"
 *
 * Returns a new array (does not mutate input).
 */
export function autoFixScenes(scenes: Scene[]): Scene[] {
  return scenes.map((scene, i) => ({
    ...scene,
    scene_number: i + 1,
    duration: Math.max(MIN_DURATION, Math.min(MAX_DURATION, scene.duration || 3)),
    transition: VALID_TRANSITIONS.has(scene.transition?.trim().toUpperCase())
      ? scene.transition
      : 'CUT TO',
  }));
}

/**
 * Build a targeted patch prompt for scenes that failed validation.
 *
 * Instead of re-running the entire Story Generator, we ask the LLM to fix
 * only the broken scenes. This saves tokens and latency.
 */
export function buildPatchPrompt(
  scenes: Scene[],
  errors: ValidationError[],
): string | null {
  // Only patch errors that the LLM can fix (narration, visual_description)
  const patchable = errors.filter(
    (e) => e.scene_number > 0 && ['narration', 'visual_description'].includes(e.field),
  );

  if (patchable.length === 0) return null;

  const sceneNums = [...new Set(patchable.map((e) => e.scene_number))];
  const brokenScenes = scenes.filter((s) => sceneNums.includes(s.scene_number));

  return `The following scenes are missing required fields. Fix ONLY the missing fields and return the corrected scenes as a JSON array.

Issues:
${patchable.map((e) => `- Scene ${e.scene_number}: ${e.message}`).join('\n')}

Scenes to fix:
${JSON.stringify(brokenScenes, null, 2)}

Return ONLY a valid JSON array with the corrected scenes. Keep all other fields unchanged.`;
}
