"""
models.py — Pydantic schemas for the Story Visualizer backend API
"""
from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel, Field


class DialogueLine(BaseModel):
    speaker: str = ""
    line: str = ""


class Scene(BaseModel):
    scene_number: int
    setting: str = "EXT. UNKNOWN - DAY"
    narration: str = ""
    dialogue: List[DialogueLine] = []
    transition: str = "CUT TO"
    visual_description: str = ""
    shot_type: str = "WIDE"
    camera_movement: str = "STATIC"
    duration: int = 3
    style: str = ""
    sfx: str = "gentle ambiance"
    seed: int = 42
    media_url: str = ""
    media_type: str = "image"


class StoryboardFrame(BaseModel):
    scene: Scene
    media_url: str
    media_type: str = "image"
    audio_url: Optional[str] = None


class ExportRequest(BaseModel):
    frames: List[StoryboardFrame]
    global_seed: int = 42
    title: str = "My Story"
    storyboard_hash: Optional[str] = None


class ExportStatus(BaseModel):
    task_id: str
    status: str  # queued | running | completed | failed
    progress: int = 0  # 0–100
    message: str = ""
    download_url: Optional[str] = None
    error: Optional[str] = None


class TTSRequest(BaseModel):
    text: str
    scene_number: int
    lang: str = "en"
    voice: Optional[str] = None   # e.g. "en-US-JennyNeural"
    rate: Optional[str] = None    # e.g. "-8%"
    pitch: Optional[str] = None   # e.g. "+0Hz"


class TTSResponse(BaseModel):
    scene_number: int
    audio_url: str


# ── V2.1: Character Memory & Validation schemas ─────────────────────────────

class CharacterMemory(BaseModel):
    appearance: str = ""
    clothing: str = ""
    personality: str = ""
    relationships: List[str] = []
    weapons: List[str] = []
    powers: List[str] = []


class StoryValidationError(BaseModel):
    scene_number: int
    field: str
    message: str


class StoryValidationResult(BaseModel):
    valid: bool
    errors: List[StoryValidationError] = []
    warnings: List[str] = []


class ValidateRequest(BaseModel):
    scenes: List[Scene]
    characters: Optional[dict] = None

