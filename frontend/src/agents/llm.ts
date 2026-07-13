// src/agents/llm.ts — shared LLM caller, proxied through the backend
// The Gemini API key lives ONLY in backend/.env; the browser never sees it.

export async function callLLM(
  _apiKey: string, // kept for signature compatibility; backend reads key from env
  prompt: string,
  jsonMode = true,
  model = 'gemini-2.5-flash',
): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
  const res = await fetch(`${backendUrl}/api/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, json_mode: jsonMode, model }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.text ?? '';
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}
