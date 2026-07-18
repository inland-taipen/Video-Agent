# ── Stage 1: Build Vite frontend ─────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
ENV NODE_ENV=development
RUN npm install

COPY frontend/ ./

# Vite bakes the backend URL into the JS bundle at build time
ARG VITE_BACKEND_URL
ARG VITE_GEMINI_API_KEY
ARG VITE_GROQ_API_KEY
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_GEMINI_API_KEY=$VITE_GEMINI_API_KEY
ENV VITE_GROQ_API_KEY=$VITE_GROQ_API_KEY

RUN npm run build

# ── Stage 2: Python backend with FFmpeg ──────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app

# System deps: ffmpeg for video compilation
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Python deps
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend source
COPY backend/ ./backend/

# Frontend static files (served by FastAPI at /*)
COPY --from=frontend-builder /app/frontend/dist ./frontend_dist/

# Output dirs
RUN mkdir -p outputs/exports outputs/tts

ENV PORT=8000
EXPOSE 8000

# WORKDIR must be /app/backend so relative imports (compiler, image_gen, models) resolve
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
