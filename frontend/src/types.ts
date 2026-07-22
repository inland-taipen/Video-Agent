// src/types.ts — shared domain types

// ── Generation Mode ─────────────────────────────────────────────────────────
// Strategy discriminant: controls prompts, style templates, and quality
// modifiers throughout the pipeline. The pipeline itself is identical.

export type GenerationMode = 'animated' | 'documentary' | 'storybook' | 'cinematic';

export const MODE_CONFIG: Record<
  GenerationMode,
  { label: string; icon: string; description: string }
> = {
  animated: {
    label: 'Animated Story',
    icon: '🎌',
    description: 'Cinematic anime story with vivid characters and drama',
  },
  documentary: {
    label: 'Documentary',
    icon: '🌍',
    description: 'Educational, calm, photorealistic BBC Earth style',
  },
  storybook: {
    label: 'Storybook',
    icon: '📚',
    description: "Soft illustrated children's tale with watercolor warmth",
  },
  cinematic: {
    label: 'Cinematic Film',
    icon: '🎞️',
    description: 'Analog film photography via M87 — moody, dramatic, cinematic',
  },
};

export interface DialogueLine {
  speaker: string;
  line: string;
}

export interface Scene {
  scene_number: number;
  setting: string;
  narration: string;
  dialogue: DialogueLine[];
  transition: string;
  visual_description: string;
  shot_type: string;
  camera_movement: string;
  duration: number;
  style: string;
  sfx?: string;
  seed: number;
  media_url: string;
  media_type: 'image' | 'video';
}

export interface StoryboardFrame {
  scene: Scene;
  media_url: string;
  media_type: 'image' | 'video';
  audio_url?: string;
  mediaLoaded?: boolean;
}

export interface ExportStatus {
  task_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  download_url?: string;
  error?: string;
}

export type StylePreset =
  | 'Storybook'
  | 'Cinematic'
  | 'Anime'
  | 'Realistic Anime'
  | 'Watercolor'
  | 'Noir'
  | 'Sci-Fi'
  | 'Fantasy'
  | 'Documentary'
  | 'Drone Footage'
  | 'Macro'
  | 'Dynamic'
  | 'Photorealistic';

export const STYLE_DESCRIPTIONS: Record<StylePreset, string> = {
  Storybook:
    "children's storybook illustration, hand-painted, soft warm colors, gentle rounded shapes, cozy and whimsical, consistent character design across scenes",
  Cinematic:
    'cinematic lighting, shallow depth of field, anamorphic lens, golden hour palette',
  Anime:
    'anime style, cel shaded, vibrant colors, dynamic composition, studio Ghibli inspired, expressive characters, beautiful backgrounds',
  'Realistic Anime':
    'hyper-realistic anime art style, Makoto Shinkai cinematic quality, ultra-detailed backgrounds, dramatic volumetric lighting, photorealistic textures with anime aesthetics, 8K quality, masterpiece illustration',
  Watercolor:
    'watercolor painting, soft washes, visible brush strokes, pastel tones, impressionist',
  Noir:
    'film noir, high contrast black and white, dramatic shadows, rain-slicked streets',
  'Sci-Fi':
    'sci-fi concept art, neon lighting, futuristic architecture, space vistas, cyberpunk',
  Fantasy:
    'epic fantasy illustration, magical glowing runes, towering castles, mythic creatures',
  Documentary:
    'documentary photography, natural lighting, candid, gritty realism, 35mm grain',
  'Drone Footage':
    'aerial photography, wide sweeping landscape, high altitude, drone shot, extreme wide angle',
  Macro:
    'macro photography, extreme close-up, sharp focus on tiny details, beautiful bokeh background',
  Dynamic:
    'highly dynamic action shot, motion blur, extreme perspective, intense energy, vibrant colors',
  Photorealistic:
    'hyper-realistic photography, 8k resolution, razor sharp, lifelike textures, natural lighting',
};

export type PipelineStage =
  | 'idle'
  | 'scriptwriter'
  | 'visual_director'
  | 'storyboard'
  | 'veo'
  | 'done'
  | 'error';

export interface PipelineState {
  stage: PipelineStage;
  message: string;
  progress: number;
}

// ── Voice / Transcription pipeline ────────────────────────────────────────

export interface TranscriptionResult {
  rawTranscript: string;
  roughScript: string;
  polishedScript: string;
  detectedLanguage?: string;
}

export type TranscriptionStage =
  | 'idle'
  | 'uploading'
  | 'transcribing'
  | 'rough_script'
  | 'polished_script'
  | 'done'
  | 'error';

export interface TranscriptionState {
  stage: TranscriptionStage;
  message: string;
  progress: number;
}
