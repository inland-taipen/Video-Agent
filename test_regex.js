const text = `
{
  "scenes": [
    {
      "scene_number": 1,
      "setting": "EXT. PARK - DAY"
    }
  ]
}
`;
let clean = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
const m = clean.match(/\[[\s\S]*\]/);
if (m) clean = m[0];
console.log("Extracted:", clean);
const parsed = JSON.parse(clean);
console.log("Is array?", Array.isArray(parsed));
