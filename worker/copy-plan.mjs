// Copies the shared team plan to a new private address, so the old public one can be dropped.
// Usage: node copy-plan.mjs <old plan url> <new plan url>
//   e.g. node copy-plan.mjs https://mantledb.sh/v2/sss-e7b1c4a9d2f6/plan https://mantledb.sh/v2/<new-random-key>/plan
// It only reads the old address and writes the new one. Run it once, then set PLAN_BASE (the new address without /plan).
const [from, to] = process.argv.slice(2);
if (!from || !to) { console.error("Usage: node copy-plan.mjs <old plan url> <new plan url>"); process.exit(1); }
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error("GET " + url + " -> " + r.status); return r.json(); };
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("POST " + url + " -> " + r.status);
};
const doc = await get(from);
const parts = doc.parts > 1 ? doc.parts : 0;
for (let i = 0; i < parts; i++) await post(to + "/part/" + i, await get(from + "/part/" + i));
await post(to, doc);
const back = await get(to);
console.log("Copied. updatedAt", back.updatedAt, "parts", back.parts || 1);
