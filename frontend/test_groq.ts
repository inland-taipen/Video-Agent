import { runScriptwriter } from './src/agents/scriptwriter.ts';

async function main() {
  const story = "A boy walked in the park.";
  const apiKey = process.env.GROQ_API_KEY || "";
  try {
    const scenes = await runScriptwriter(story, apiKey, "Cinematic" as any);
    console.log(scenes);
  } catch (e) {
    console.error(e);
  }
}
main();
