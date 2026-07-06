# Stage 1: Build the Vite frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
# Force development mode for install so devDependencies (Vite, TypeScript) are installed
ENV NODE_ENV=development
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build the FastAPI backend with FFmpeg
FROM python:3.9-slim
WORKDIR /app

# Install system dependencies (ffmpeg)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Copy python dependencies
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy frontend build from stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy backend source
COPY backend/ ./backend/

# Set working directory to backend so uvicorn can find main.py and outputs directory
WORKDIR /app/backend

# Expose the port (Render sets PORT env variable)
ENV PORT=8000
EXPOSE 8000

# Start Uvicorn
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
