// src/agents/imagen.ts
// Image generation via Google Imagen 3 — routed through backend to avoid CORS

/**
 * Generate a single image using Imagen 3 via the backend proxy.
 * Returns a base64 data URL (e.g. "data:image/png;base64,...").
 */
export async function generateImageWithImagen(
  prompt: string,
  _apiKey: string,  // kept for signature compatibility; backend reads key from env
  seed: number = 42,
  mode: string = "animated",
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  const res = await fetch(`${backendUrl}/api/imagen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, seed, aspect_ratio: '16:9', mode }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Imagen 3 backend error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.dataUrl) throw new Error('Imagen 3 returned no image data');
  return data.dataUrl;
}
