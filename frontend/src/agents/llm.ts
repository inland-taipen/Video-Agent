// src/agents/llm.ts — shared Groq LLM API caller

const GROQ_BASE = 'https://api.groq.com/openai/v1';

export async function callLLM(
  apiKey: string,
  prompt: string,
  jsonMode = true,
  model = 'llama-3.3-70b-versatile',
): Promise<string> {
  const url = `${GROQ_BASE}/chat/completions`;
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.2,
    top_p: 0.95,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Empty response from Groq');
  return text;
}
