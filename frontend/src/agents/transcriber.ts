// src/agents/transcriber.ts
// Groq audio agent: audio → raw transcript → rough script → polished script

import { TranscriptionResult } from '../types';
import { callLLM } from './llm';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Raw Transcript via Groq Whisper
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeAudio(
  apiKey: string,
  file: File,
): Promise<{ transcript: string; language: string }> {
  // We use whisper-large-v3, which has excellent multilingual support
  const url = `${GROQ_BASE}/audio/transcriptions`;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', 'whisper-large-v3');
  // Request verbose JSON to get language info
  formData.append('response_format', 'verbose_json');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq Audio API error ${res.status}: ${err.slice(0, 400)}`);
  }

  const data = await res.json();
  const transcript = data.text;
  const language = data.language || 'English';

  if (!transcript) throw new Error('Empty transcript from Whisper');

  return { transcript, language };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — Rough Script
// ─────────────────────────────────────────────────────────────────────────────

async function generateRoughScript(
  apiKey: string,
  rawTranscript: string,
  detectedLanguage: string,
): Promise<string> {
  const prompt = `You are a story editor. Below is a raw transcript from a voice recording (narrated in ${detectedLanguage}).

Your task: Clean this up into a ROUGH SCRIPT. 
- Remove filler words (um, uh, like, you know) and false starts
- Fix grammatical flow but preserve the ORIGINAL VOICE and tone — keep it feeling personal and authentic
- Add paragraph breaks at natural story beats
- If the story is NOT in English, first provide the original language version, then below it provide an English translation labeled "--- English Translation ---"
- Do NOT add dramatic embellishments yet — keep it close to what was actually said

Raw Transcript:
"""
${rawTranscript}
"""

Return ONLY the cleaned script text, no meta-commentary or markdown blocks.`;

  // Use jsonMode=false since we just want text
  return callLLM(apiKey, prompt, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — Polished Script
// ─────────────────────────────────────────────────────────────────────────────

async function generatePolishedScript(
  apiKey: string,
  roughScript: string,
): Promise<string> {
  const prompt = `You are a professional narrative screenwriter. Below is a rough script from a personal story recording.

Your task: Transform this into a POLISHED NARRATIVE STORY ready for visual storyboarding.
- Write in flowing, vivid English prose
- Preserve the emotional core, cultural context, and personal details
- Add sensory details (what characters see, hear, feel) that would make great visuals
- Structure it as a narrative with a clear beginning, middle, and end
- Aim for 150-400 words — concise enough for a 4-8 scene storyboard video
- Do NOT invent major plot points that weren't implied — stay true to the original story

Rough Script:
"""
${roughScript}
"""

Return ONLY the polished story narrative, no headers, meta-commentary, or markdown blocks.`;

  return callLLM(apiKey, prompt, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export — full 3-stage pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriberProgressCallback {
  (stage: 'transcribing' | 'rough_script' | 'polished_script', message: string, progress: number): void;
}

export async function runTranscriber(
  file: File,
  apiKey: string,
  onProgress: TranscriberProgressCallback,
): Promise<TranscriptionResult> {
  // Stage 1: Raw transcript (using FormData upload)
  onProgress('transcribing', '🎙️ Transcribing audio with Groq Whisper…', 20);
  const { transcript, language } = await transcribeAudio(apiKey, file);

  // Stage 2: Rough script
  onProgress('rough_script', '📝 Generating rough script…', 55);
  const roughScript = await generateRoughScript(apiKey, transcript, language);

  // Stage 3: Polished script
  onProgress('polished_script', '🎬 Polishing into screenplay…', 80);
  const polishedScript = await generatePolishedScript(apiKey, roughScript);

  return {
    rawTranscript: transcript,
    roughScript,
    polishedScript,
    detectedLanguage: language,
  };
}
