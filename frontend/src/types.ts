// src/types.ts — shared domain types

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
  | 'Cinematic'
  | 'Anime'
  | 'Watercolor'
  | 'Noir'
  | 'Sci-Fi'
  | 'Fantasy'
  | 'Documentary';

export const STYLE_DESCRIPTIONS: Record<StylePreset, string> = {
  Cinematic:
    'photorealistic, cinematic lighting, shallow depth of field, anamorphic lens, golden hour palette',
  Anime:
    'anime style, cel shaded, vibrant colors, dynamic composition, studio Ghibli inspired',
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
};

export type PipelineStage =
  | 'idle'
  | 'scriptwriter'
  | 'visual_director'
  | 'storyboard'
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
