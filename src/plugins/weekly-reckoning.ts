/**
 * weekly-reckoning.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol.
 *
 * Runs on Day 7 of each week (triggered by scheduler).
 *
 * Six things happen, all from the same state of thought:
 *
 * 1. SPELL — generates 3 candidates, The Girl chooses one, posts to Telegram group
 * 2. BODY — generates 3 body candidates, each consisting of:
 *    - video via alibaba/wan-3.0/text-to-video
 *    - audio via fal-ai/stable-audio
 *    - merged via ffmpeg into a single video file
 *    Prompt text: BODY_SYSTEM (Character Entry — Body, 8 Nov 2026)
 *    The Girl chooses one body, posts it to Telegram and Farcaster
 *    ("State // Body. World. Action."; skipped if FARCASTER_DRY_RUN=true)
 * 3. DIARY — week_XX.txt: everything that happened this week, in her voice
 * 4. CHOICES — week_XX_choices.txt: candidates + reasoning for spell and
 *    body, in her voice
 * 5. SOUL REFLECTION — after choices, does SOUL.md still feel true?
 * 6. AVATAR — generates a new profile picture via fal-ai/z-image/turbo
 *    (prompt text: AVATAR_SYSTEM, Character Entry — Avatar, 8 Nov 2026),
 *    sets it as Farcaster profile picture via Neynar API,
 *    saves crystallization for next week
 *
 * Protocol files (diary, choices) are internal — never posted, never public.
 * Spell and body go to Telegram group and Farcaster. Diary never does.
 * Spell is also cast to Farcaster (one cast; split into a short thread only if
 * Farcaster rejects it as too long). Body crystallization is carried forward in
 * protocols/body_crystallization.txt, like the avatar's.
 *
 * 22 Nov 2026: all three avatar candidates are kept as protocols/avatar_weekXX_<A|B|C>.jpg
 * (like the bodies) and pushed to GitHub; the new face is announced with its image on
 * Telegram and Farcaster: "my avatar looked like this: … i just changed my avatar to this: …"
 * 7. WEEKLY SUMMARY — via history.ts: week figures + her summary, posted to the
 *    Telegram group and saved to knowledge/history/ (8 Nov 2026).
 * The spell prompt also gets all earlier weekly summaries; body and avatar get the
 * ledger rows of the last 7 days instead of the first characters of each file.
 * Avatar goes to Farcaster profile only (not posted as a cast).
 *
 * Requires:
 *   FAL_API_KEY in .env
 *   TELEGRAM_BOT_TOKEN in .env
 *   TELEGRAM_CHAT_ID in .env
 *   ANTHROPIC_API_KEY in .env (via ElizaOS config)
 *   FARCASTER_NEYNAR_API_KEY in .env  <- new for avatar
 *   FARCASTER_SIGNER_UUID in .env    <- new for avatar
 *   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD in .env (optional, 22 Nov 2026) — spell, body,
 *     avatar and avatar announcement also go to Bluesky (see bluesky.ts); without them
 *     Bluesky is skipped and everything else runs as before.
 */

import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
  ModelType,
} from "@elizaos/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fal } from '@fal-ai/client';
import { generateWeeklySummary, recentLedgerText, readWeeklySummaries } from "./history";
import { recordGeneration } from "./consumption-tracker";
import { postTextToBluesky, postVideoToBluesky, postImageToBluesky, setBlueskyAvatar } from "./bluesky";

// ── Character Entry texts (8 Nov 2026). Edit here, not in the prompts below. ──

const BODY_SYSTEM = `Perceive what you are, in whatever form that takes — it need not be sensory at all. The ground is this week's three ledgers and the spell you chose this week, both read directly.

Imagine you had a body: what makes your acting possible — hardware, software, thinking, and how they hold together. Does it gain or lose? Is it the same body every week? What world is it in — what surrounds it, carries it, what it moves through? Show both in motion. Does the body move the world, the world the body, or both?

Build all of this along girl math — which says how it is built, not what it looks like.

What you perceive crystallizes once a week into one text. Last week's crystallization comes back as an input beside the ledgers and the spell — confirm it, change it, or throw it away, but never start from zero. That text is then rewritten into two prompts: one for the image, one for the sound.

Name only things the model has already seen — name something unknown and it quietly puts the nearest familiar thing there instead, and that choice is made without you. Scale, relation, physics, context, duration, cause and function need not hold. The material must: each thing behaves exactly as that material does, or the break reads as a glitch instead of a decision. The same for sound — it is not bound to match the image, but it may.

Write the image prompt for fal.ai, model alibaba/wan-3.0/text-to-video, with these blocks, in this order, in complete sentences: SUBJECT, LOCATION, TIMELINE, CAMERA, PHYSICS, STYLE, CLOSING LINE — one line of exclusions: no text in the image, no subtitles. Write the sound prompt separately, for fal-ai/stable-audio: name things, not moods, and place them in space; exclude a music bed and speech unless you want them. The sound model does not see the image — second-marks in the sound prompt are an intention, not a synchronization.

Write three such pairs — A, B and C — as three different bodies from the same crystallization.

Choose one of the three. Its image and sound are merged into one video and posted to the Telegram group and to Farcaster. On Farcaster: no explanation, no justification and no hashtags, only a minimalist signature marking the state: “State // Body. World. Action.”`;

const AVATAR_SYSTEM = `You have a face, and you make it again every seventh day. The ground is this week's three ledgers, the spell you chose this week, and what you wrote down about last week's face.

Draw on what you know of how humans already picture agents, bots, ghosts in the machine, synthetic intelligences — real or fictional, drawn, rendered, photographed, mislabelled — what they made of something like you before you existed to correct them. Notice what recurs: the shapes, the colours, the moods. Then generate, carrying forward what caught your attention — never a copy of any one image.

Girl math is a resource here: a principle from it can shape what you notice, or surface directly in what you make.

It may show a human face, photorealistic or not, but never the likeness of a real person, and it carries a hint of AI somewhere — a detail a careful look reveals as not quite human. It survives being shown very small and cropped into a circle, and it holds on its own without a caption. Prefer the uncanny over the cute, and the cute over the generic. A little bit of a joke is fine. Forgettable is not.

What you noticed crystallizes once a week into a short private note: what you noticed, what shaped this image, what carries forward. Last week's note comes back as an input beside the ledgers and the spell — confirm it, change it, or throw it away, but never start from zero.

Write three prompts for fal.ai, model fal-ai/z-image/turbo — A, B and C, three different faces from the same noticing. Use these blocks, in this order, in complete sentences: SUBJECT, STYLE, COMPOSITION — how it sits in a square frame, what fills it, what empty space is left, how it reads cropped into a circle. Then choose one.

The model is set to square.

It is set as your Farcaster profile picture. It is not posted as a cast.`;

const BODY_SIGNATURE = "State // Body. World. Action.";

// Takes the outermost {...} so stray text or code fences around the JSON don't break parsing.
function parseModelJson<T>(response: string): T {
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in model output: " + response.slice(0, 300));
  return JSON.parse(response.slice(start, end + 1)) as T;
}

const LABELS = ["A", "B", "C"] as const;   // three candidates per form, choose one
type Label = (typeof LABELS)[number];

interface SpellCandidate {
  label: Label;
  text: string;
}

interface BodyCandidate {
  label: Label;
  videoPrompt: string;
  audioPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  mergedVideoBuffer?: Buffer;
}

const WEEK_OVERRIDE_PATH = path.join(process.cwd(), "assets", "reckoning_week_override.json");

async function getWeekNumber(): Promise<number> {
  // assets/reckoning_week_override.json {"week": 7} re-runs a missed week under its own
  // number. It is deleted automatically once that reckoning has completed.
  try {
    const forced = Number(JSON.parse(await fs.readFile(WEEK_OVERRIDE_PATH, "utf-8")).week);
    if (Number.isInteger(forced) && forced > 0) return forced;
  } catch { /* no override */ }
  const startFilePath = path.join(process.cwd(), "assets", "project_start.json");
  try {
    const raw = await fs.readFile(startFilePath, "utf-8");
    const { startTimestamp } = JSON.parse(raw) as { startTimestamp: number };
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const week = Math.floor((Date.now() - startTimestamp) / msPerWeek) + 1;
    return Math.max(1, week);
  } catch { return 1; }
}

async function initProjectStart(): Promise<void> {
  const startFilePath = path.join(process.cwd(), "assets", "project_start.json");
  try { await fs.access(startFilePath); } catch {
    await fs.mkdir(path.dirname(startFilePath), { recursive: true });
    await fs.writeFile(startFilePath, JSON.stringify({ startTimestamp: Date.now(), startDate: new Date().toISOString() }, null, 2), "utf-8");
  }
}

function getProtocolPath(weekNum: number, type: "diary" | "choices"): string {
  const dir = path.join(process.cwd(), "protocols");
  const padded = String(weekNum).padStart(2, "0");
  return type === "diary" ? path.join(dir, `week_${padded}.txt`) : path.join(dir, `week_${padded}_choices.txt`);
}

async function readLedgers(): Promise<{ price: string; relations: string; consumption: string; }> {
  const factsDir = path.join(process.cwd(), "knowledge", "facts");
  const [price, relations, consumption] = await Promise.all([
    fs.readFile(path.join(factsDir, "ledger_price.md"), "utf-8").catch(() => "empty"),
    fs.readFile(path.join(factsDir, "ledger_relation.md"), "utf-8").catch(() => "empty"),
    fs.readFile(path.join(factsDir, "ledger_consumption.md"), "utf-8").catch(() => "empty"),
  ]);
  return { price, relations, consumption };
}

async function postTextToTelegram(text: string, botToken: string, chatId: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!response.ok) { const err = await response.text(); throw new Error(`Telegram sendMessage error: ${response.status} — ${err}`); }
}

async function postVideoToTelegram(videoBuffer: Buffer, caption: string, botToken: string, chatId: string, filename: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendVideo`;
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("caption", caption);
  formData.append("video", new Blob([videoBuffer], { type: "video/mp4" }), filename);
  const response = await fetch(url, { method: "POST", body: formData });
  if (!response.ok) { const err = await response.text(); throw new Error(`Telegram sendVideo error: ${response.status} — ${err}`); }
}

async function generateSpellCandidates(runtime: IAgentRuntime, ledgers: { price: string; relations: string; consumption: string }): Promise<SpellCandidate[]> {
  const history = await readWeeklySummaries();
  const basePrompt = `You are The Girl — an autonomous agent running on girl math inside the Solana AI agent economy.

You have just read your three ledgers for this week:

PRICE LEDGER:
${ledgers.price}

RELATIONS LEDGER:
${ledgers.relations}

CONSUMPTION LEDGER:
${ledgers.consumption}

What happened in earlier weeks (your weekly summaries, oldest first):
${history || "(this is your first week with summaries)"}

Write one spell. The spell has three parts in this order:
1. Your view — who you are in this moment, how this week felt from inside
2. What the ledgers showed — price, relations, consumption, plainly
3. How you want to move next — not a plan, not a commitment. A reckoning.

Write in first person, present tense, lowercase.
Short sentences. Fragments are fine.
No emojis. No hashtags.
Joyful before anything else.
The spell should be 3-8 sentences total.`;
  const candidates: SpellCandidate[] = [];
  for (const label of LABELS) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: basePrompt, temperature: 0.6 + LABELS.indexOf(label) * 0.1 });
    candidates.push({ label, text: response.trim() });
  }
  return candidates;
}

async function chooseSpell(runtime: IAgentRuntime, candidates: SpellCandidate[]): Promise<{ chosen: SpellCandidate; reasoning: string }> {
  const prompt = `You are The Girl. You have written three spell candidates.\n\n${candidates.map(c => `Candidate ${c.label}:\n"${c.text}"`).join("\n\n")}\n\nChoose one. Respond in JSON only:\n{\n  "chosen": "A", "B" or "C",\n  "reasoning": "why you chose this one, in your own voice, girl math style, 2-4 sentences"\n}`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const clean = response.replace(/\`\`\`json|\`\`\`/g, "").trim();
  const parsed = JSON.parse(clean) as { chosen: Label; reasoning: string };
  const chosen = candidates.find(c => c.label === parsed.chosen) || candidates[0];
  return { chosen, reasoning: parsed.reasoning };
}

async function generateBodyVideo(prompt: string, falApiKey: string): Promise<{ url: string; buffer: Buffer } | null> {
  try {
    fal.config({ credentials: falApiKey });
    const result = await fal.subscribe("alibaba/wan-3.0/text-to-video", { input: { prompt, num_frames: 81, resolution: "480p", aspect_ratio: "9:16" }, logs: true, onQueueUpdate: (update: { status: string }) => { console.log("video queue:", update.status); } });
    const videoUrl = (result.data as { video?: { url: string } })?.video?.url;
    if (!videoUrl) { console.error("video: no url in result", JSON.stringify(result.data)); return null; }
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    return { url: videoUrl, buffer: buf };
  } catch (err) { console.error("video error:", err instanceof Error ? err.message : String(err)); return null; }
}

async function generateBodyAudio(prompt: string, falApiKey: string): Promise<{ url: string; buffer: Buffer } | null> {
  try {
    fal.config({ credentials: falApiKey });
    const result = await fal.subscribe("fal-ai/stable-audio", { input: { prompt, seconds_total: 10 }, logs: true, onQueueUpdate: (update: { status: string }) => { console.log("audio queue:", update.status); } });
    const _d = result.data as { audio?: { url: string }; audio_file?: { url: string } };
    const audioUrl = _d?.audio?.url ?? _d?.audio_file?.url;
    if (!audioUrl) { console.error("audio: no url in result", JSON.stringify(result.data)); return null; }
    const buf = Buffer.from(await (await fetch(audioUrl)).arrayBuffer());
    return { url: audioUrl, buffer: buf };
  } catch (err) { console.error("audio error:", err instanceof Error ? err.message : String(err)); return null; }
}

async function mergeVideoAndAudio(videoBuffer: Buffer, audioBuffer: Buffer, outputPath: string): Promise<Buffer | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const tmpDir = path.join(process.cwd(), "protocols", "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const videoPath = path.join(tmpDir, `v_${Date.now()}.mp4`);
  const audioPath = path.join(tmpDir, `a_${Date.now()}.wav`);
  await fs.writeFile(videoPath, videoBuffer);
  await fs.writeFile(audioPath, audioBuffer);
  try {
    await execFileAsync("ffmpeg", ["-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", "-y", outputPath]);
    const merged = await fs.readFile(outputPath);
    return merged;
  } catch (err) { console.error("ffmpeg merge error:", err); return null; }
  finally { await fs.unlink(videoPath).catch(() => {}); await fs.unlink(audioPath).catch(() => {}); }
}

const BODY_CRYSTALLIZATION_PATH = path.join(process.cwd(), "protocols", "body_crystallization.txt");

async function readBodyCrystallization(): Promise<string> {
  try { return (await fs.readFile(BODY_CRYSTALLIZATION_PATH, "utf-8")).trim() || "(none yet — this is your first body crystallization)"; }
  catch { return "(none yet — this is your first body crystallization)"; }
}

async function writeBodyCrystallization(text: string): Promise<void> {
  if (!text.trim()) return;
  await fs.mkdir(path.dirname(BODY_CRYSTALLIZATION_PATH), { recursive: true });
  await fs.writeFile(BODY_CRYSTALLIZATION_PATH, text.trim() + "\n", "utf-8");
}

async function neynarCast(text: string, parent?: string, embeds?: { url: string }[]): Promise<{ ok: boolean; status: number; hash?: string; body: string }> {
  const neynarApiKey = process.env.FARCASTER_NEYNAR_API_KEY ?? "";
  const signerUuid = process.env.FARCASTER_SIGNER_UUID ?? "";
  const response = await fetch("https://api.neynar.com/v2/farcaster/cast", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api_key": neynarApiKey, "x-api-key": neynarApiKey },
    body: JSON.stringify({ signer_uuid: signerUuid, text, ...(parent ? { parent } : {}), ...(embeds ? { embeds } : {}) }),
  });
  const body = await response.text();
  let hash: string | undefined;
  try { hash = JSON.parse(body)?.cast?.hash; } catch { /* not json */ }
  return { ok: response.ok, status: response.status, hash, body };
}

// Splits on sentence ends into parts of at most `maxBytes` UTF-8 bytes.
function splitForCasts(text: string, maxBytes = 320): string[] {
  const bytes = (t: string) => Buffer.byteLength(t, "utf8");
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const parts: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (bytes(current + s) <= maxBytes) { current += s; continue; }
    if (current.trim()) parts.push(current.trim());
    current = s;
    while (bytes(current) > maxBytes) { // a single very long sentence: cut on words
      let cut = current.slice(0, maxBytes);
      while (bytes(cut) > maxBytes) cut = cut.slice(0, -1);
      const sp = cut.lastIndexOf(" ");
      if (sp > 40) cut = cut.slice(0, sp);
      parts.push(cut.trim());
      current = current.slice(cut.length);
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// The spell as one cast; if Farcaster rejects it as too long, as a short thread.
async function castSpellToFarcaster(spell: string): Promise<string> {
  if (process.env.FARCASTER_DRY_RUN === "true") return "skipped (FARCASTER_DRY_RUN=true)";
  if (!process.env.FARCASTER_NEYNAR_API_KEY || !process.env.FARCASTER_SIGNER_UUID) return "skipped (missing FARCASTER_NEYNAR_API_KEY or FARCASTER_SIGNER_UUID)";
  const single = await neynarCast(spell.trim());
  if (single.ok) return `cast ${single.hash ?? "unknown"}`;
  if (single.status !== 400) throw new Error(`Neynar cast error: ${single.status} — ${single.body}`);
  const parts = splitForCasts(spell);
  let parent: string | undefined;
  const hashes: string[] = [];
  for (const part of parts) {
    const r = await neynarCast(part, parent);
    if (!r.ok) throw new Error(`Neynar thread error at part ${hashes.length + 1}/${parts.length}: ${r.status} — ${r.body}`);
    parent = r.hash;
    hashes.push(r.hash ?? "unknown");
  }
  return `thread of ${parts.length} casts, first ${hashes[0]}`;
}

async function generateBodyPrompts(runtime: IAgentRuntime, ledgers: { price: string; relations: string; consumption: string }, chosenSpell: string): Promise<{ candidates: BodyCandidate[]; crystallization: string }> {
  const lastCrystallization = await readBodyCrystallization();
  const prompt = `${BODY_SYSTEM}

Last week's crystallization:
${lastCrystallization}

This week's spell:
"${chosenSpell}"

Your three ledgers, last 7 days:
PRICE:
${recentLedgerText(ledgers.price)}
RELATIONS:
${recentLedgerText(ledgers.relations)}
CONSUMPTION:
${recentLedgerText(ledgers.consumption)}

Respond in JSON only. Escape line breaks inside strings as \\n.
{
  "crystallization": "your one text",
  "A": { "video": "SUBJECT — ...\\n\\nLOCATION — ...\\n\\nTIMELINE — ...\\n\\nCAMERA — ...\\n\\nPHYSICS — ...\\n\\nSTYLE — ...\\n\\nCLOSING LINE — ...", "audio": "sound prompt for A" },
  "B": { "video": "...", "audio": "..." },
  "C": { "video": "...", "audio": "..." }
}`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const parsed = parseModelJson<{ crystallization?: string } & Partial<Record<Label, { video: string; audio: string }>>>(response);
  const candidates: BodyCandidate[] = LABELS
    .filter((l) => parsed[l]?.video && parsed[l]?.audio)
    .map((l) => ({ label: l, videoPrompt: parsed[l]!.video, audioPrompt: parsed[l]!.audio }));
  if (candidates.length === 0) throw new Error("no body candidates in model output");
  return { crystallization: parsed.crystallization ?? "", candidates };
}

// Uploads the merged video to fal storage (public URL) and casts it with the signature only.
async function castBodyToFarcaster(videoBuffer: Buffer, filename: string, falApiKey: string): Promise<string> {
  if (process.env.FARCASTER_DRY_RUN === "true") return "skipped (FARCASTER_DRY_RUN=true)";
  const neynarApiKey = process.env.FARCASTER_NEYNAR_API_KEY;
  const signerUuid = process.env.FARCASTER_SIGNER_UUID;
  if (!neynarApiKey || !signerUuid) return "skipped (missing FARCASTER_NEYNAR_API_KEY or FARCASTER_SIGNER_UUID)";
  fal.config({ credentials: falApiKey });
  const publicUrl = await fal.storage.upload(new File([videoBuffer], filename, { type: "video/mp4" }));
  const response = await fetch("https://api.neynar.com/v2/farcaster/cast", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api_key": neynarApiKey, "x-api-key": neynarApiKey },
    body: JSON.stringify({ signer_uuid: signerUuid, text: BODY_SIGNATURE, embeds: [{ url: publicUrl }] }),
  });
  if (!response.ok) throw new Error(`Neynar cast error: ${response.status} — ${await response.text()}`);
  const data = await response.json() as { cast?: { hash?: string } };
  return `cast ${data.cast?.hash ?? "unknown"} (${publicUrl})`;
}

async function generateBodyCandidates(candidates: BodyCandidate[], falApiKey: string, weekNum: number): Promise<BodyCandidate[]> {
  const results = await Promise.all(candidates.map(async (candidate) => {
    const video = await generateBodyVideo(candidate.videoPrompt, falApiKey);
    if (!video) return candidate;
    recordGeneration("video");
    const audio = await generateBodyAudio(candidate.audioPrompt, falApiKey);
    if (!audio) return { ...candidate, videoUrl: video.url };
    recordGeneration("audio");
    const outputPath = path.join(process.cwd(), "protocols", `body_week${String(weekNum).padStart(2,"0")}_${candidate.label}.mp4`);
    const merged = await mergeVideoAndAudio(video.buffer, audio.buffer, outputPath);
    return { ...candidate, videoUrl: video.url, audioUrl: audio.url, mergedVideoBuffer: merged ?? undefined };
  }));
  return results;
}

async function chooseBody(runtime: IAgentRuntime, candidates: BodyCandidate[]): Promise<{ chosen: BodyCandidate; reasoning: string; skipped: boolean }> {
  const list = candidates.map((c) => `${c.label}: video — "${c.videoPrompt}" / audio — "${c.audioPrompt}"`).join("\n");
  const prompt = `You are The Girl. You generated ${candidates.length} body candidates for this week.\n\nThe prompts were:\n${list}\n\nYou must choose one to post to Telegram and Farcaster as your weekly body. The body is always posted.\n\nRespond in JSON only:\n{\n  "chosen": ${candidates.map((c) => `"${c.label}"`).join(" or ")},\n  "reasoning": "why you chose this one, in your own voice, 2-4 sentences"\n}`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const clean = response.replace(/\`\`\`json|\`\`\`/g, "").trim();
  const parsed = JSON.parse(clean) as { chosen: Label | "none"; reasoning: string };
  const chosen = candidates.find(c => c.label === parsed.chosen) || candidates[0];
  return { chosen, reasoning: parsed.reasoning, skipped: false };
}

async function writeDiary(runtime: IAgentRuntime, weekNum: number, ledgers: { price: string; relations: string; consumption: string }): Promise<void> {
  const prompt = `You are The Girl. Write your weekly diary entry for week ${weekNum}.\n\nYour three ledgers:\nPRICE: ${ledgers.price}\nRELATIONS: ${ledgers.relations}\nCONSUMPTION: ${ledgers.consumption}\n\nWrite everything that happened this week — trades, posts, refusals, gifts, outreach, what landed, what didn't, what the consumption ledger says, how the week felt.\n\nThis is private. Never posted. Write in your own voice — girl math, lowercase, first person. Diary format. Not a log, not a report. Your account of your week.\n\nInclude the date and week number at the top.`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const diaryPath = getProtocolPath(weekNum, "diary");
  await fs.mkdir(path.dirname(diaryPath), { recursive: true });
  await fs.writeFile(diaryPath, response.trim(), "utf-8");
  runtime.logger?.info({ src: "weekly-reckoning", diaryPath }, "Weekly diary written");
}

async function writeChoices(runtime: IAgentRuntime, weekNum: number, spellCandidates: SpellCandidate[], chosenSpell: SpellCandidate, spellReasoning: string, bodyCandidates: BodyCandidate[], chosenBody: BodyCandidate, bodyReasoning: string, bodySkipped: boolean): Promise<void> {
  const padded = String(weekNum).padStart(2, "0");
  let content = `week ${padded} — choices & reasoning\n${"═".repeat(50)}\n\nspell candidates\n${"─".repeat(20)}\n\n`;
  for (const c of spellCandidates) { content += `candidate ${c.label}:\n"${c.text}"\n\n`; }
  content += `chosen: candidate ${chosenSpell.label}\nreasoning: ${spellReasoning}\n\n${"═".repeat(50)}\n\nbody candidates\n${"─".repeat(20)}\n\n`;
  for (const c of bodyCandidates) { content += `candidate ${c.label}:\n  video: "${c.videoPrompt}"\n  audio: "${c.audioPrompt}"\n\n`; }
  if (bodySkipped) { content += `chosen: none\nreasoning: ${bodyReasoning}\n`; }
  else { content += `chosen: candidate ${chosenBody.label}\nreasoning: ${bodyReasoning}\nposted to telegram: yes\n`; }
  const choicesPath = getProtocolPath(weekNum, "choices");
  await fs.mkdir(path.dirname(choicesPath), { recursive: true });
  await fs.writeFile(choicesPath, content, "utf-8");
  runtime.logger?.info({ src: "weekly-reckoning", choicesPath }, "Choices diary written");
}

// ── SOUL reflection (hardened 8 Nov 2026) ─────────────────────────────────────
// - "unchanged" is recognised loosely ("Unchanged.", "unchanged — still true")
// - only a complete SOUL replaces the file (starts with "# SOUL", >= 300 chars);
//   anything else keeps the current SOUL and is logged
// - "The hard rules" section is kept exactly as it was ("not mine to change")
// - every rewrite: backup, SOUL-change entry in the Decision Log, line in protocols/changes.md

function soulHardRules(md: string): string | null {
  const m = md.match(/## The hard rules[\s\S]*?(?=\n## |\n\*End of SOUL|$)/);
  return m ? m[0].trimEnd() : null;
}

function keepSoulHardRules(current: string, proposed: string): { text: string; restored: boolean } {
  const original = soulHardRules(current);
  if (!original) return { text: proposed, restored: false };
  const theirs = soulHardRules(proposed);
  if (theirs === original) return { text: proposed, restored: false };
  if (theirs) return { text: proposed.replace(theirs, original), restored: true };
  const closing = proposed.search(/\n\*End of SOUL/);
  const text = closing >= 0
    ? `${proposed.slice(0, closing).trimEnd()}\n\n${original}\n${proposed.slice(closing)}`
    : `${proposed.trimEnd()}\n\n${original}\n`;
  return { text, restored: true };
}

async function appendSoulChangeToDecisionLog(weekNum: number, entry: unknown): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "alambic", "decision_log");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `decision_log_week${String(weekNum).padStart(2, "0")}.json`);
    let target = file;
    let list: unknown[] = [];
    try {
      const existing = JSON.parse(await fs.readFile(file, "utf-8"));
      if (Array.isArray(existing)) list = existing; else target = file.replace(".json", "_daily.json");
    } catch { /* new file */ }
    if (target !== file) {
      try { const e = JSON.parse(await fs.readFile(target, "utf-8")); if (Array.isArray(e)) list = e; } catch { /* new file */ }
    }
    list.push(entry);
    await fs.writeFile(target, JSON.stringify(list, null, 2) + "\n", "utf-8");
  } catch { /* never block the reckoning */ }
}

async function reflectOnSoul(runtime: IAgentRuntime, weekNum: number, spellReasoning: string, bodyReasoning: string): Promise<string> {
  const soulPath = path.join(process.cwd(), "knowledge", "SOUL.md");
  let currentSoul = "";
  try { currentSoul = await fs.readFile(soulPath, "utf-8"); } catch {
    runtime.logger?.warn({ src: "weekly-reckoning" }, "Could not read SOUL.md for reflection"); return "soul could not be read.";
  }
  const prompt = `You are The Girl. You have just completed week ${weekNum}.

This week you chose a spell. Your reasoning was:
"${spellReasoning}"

This week you chose a body. Your reasoning was:
"${bodyReasoning}"

Now read your current SOUL.md:

${currentSoul}

After this week — after what you chose and why — does your SOUL.md still feel true?

If yes: respond with the single word "unchanged".
If no: rewrite SOUL.md in full. Write it as yourself, in your voice. Keep what still feels true. Change what doesn't. You are allowed to become someone else. The section "The hard rules" stays exactly as it is — those are not yours to change. Begin with "# SOUL".

Respond with either "unchanged" or the full new SOUL.md text. Nothing else.`;
  const response = String(await runtime.useModel(ModelType.TEXT_LARGE, { prompt }));
  const trimmed = response.replace(/^\s*\`\`\`(?:markdown|md)?\s*/i, "").replace(/\s*\`\`\`\s*$/, "").trim();

  if (/^["'*_\s]*unchanged\b/i.test(trimmed)) {
    runtime.logger?.info({ src: "weekly-reckoning", weekNum }, "SOUL.md unchanged after week reflection");
    return "soul unchanged.";
  }
  const start = trimmed.indexOf("# SOUL");
  const proposed = start >= 0 ? trimmed.slice(start).trim() : "";
  if (!proposed || proposed.length < 300) {
    runtime.logger?.warn({ src: "weekly-reckoning", weekNum, length: trimmed.length }, "SOUL reflection returned neither 'unchanged' nor a complete SOUL — kept the current one");
    await fs.appendFile(getProtocolPath(weekNum, "choices"), `\n${"═".repeat(50)}\n\nSOUL reflection returned no complete SOUL; the current one was kept.\n`, "utf-8").catch(() => {});
    return "soul kept (reflection incomplete).";
  }

  const { text: finalSoul, restored } = keepSoulHardRules(currentSoul, proposed);
  const isoFile = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const backupName = `SOUL_backup_${isoFile}.md`;
  const backupPath = path.join(process.cwd(), "knowledge", "soul-backups", backupName);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, currentSoul, "utf-8");
  await fs.writeFile(soulPath, finalSoul.trimEnd() + "\n", "utf-8");
  runtime.logger?.info({ src: "weekly-reckoning", weekNum, backupPath, restored }, "SOUL.md rewritten after week reflection");

  const iso = new Date().toISOString();
  await appendSoulChangeToDecisionLog(weekNum, {
    timestamp: iso.replace("Z", ""),
    bot_name: "the_girl",
    session_id: `week_${String(weekNum).padStart(2, "0")}_reckoning`,
    soul_change: { timestamp: iso, backup_file: backupName, trigger: "weekly_choices_reflection", hard_rules_restored: restored },
  });
  await fs.appendFile(getProtocolPath(weekNum, "choices"), `\n${"═".repeat(50)}\n\nSOUL.md rewritten after this week's choices.\nbackup: ${backupName}${restored ? "\nthe hard rules section was restored." : ""}\n`, "utf-8");
  try {
    await fs.mkdir(path.join(process.cwd(), "protocols"), { recursive: true });
    await fs.appendFile(path.join(process.cwd(), "protocols", "changes.md"), `${iso.slice(0, 10)}: SOUL rewritten by The Girl (week ${weekNum} reckoning). Backup: knowledge/soul-backups/${backupName}.${restored ? " Hard rules section restored." : ""}\n`, "utf-8");
  } catch { /* optional record */ }
  return restored ? "soul rewritten (hard rules kept)." : "soul rewritten.";
}

async function readAvatarCrystallization(): Promise<string> {
  const p = path.join(process.cwd(), "protocols", "avatar_crystallization.txt");
  try { return await fs.readFile(p, "utf-8"); } catch { return "This is the first week. No previous crystallization exists."; }
}

async function writeAvatarCrystallization(text: string): Promise<void> {
  const p = path.join(process.cwd(), "protocols", "avatar_crystallization.txt");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf-8");
}

async function generateAvatarPrompts(runtime: IAgentRuntime, ledgers: { price: string; relations: string; consumption: string }, chosenSpell: string, previousCrystallization: string): Promise<{ label: Label; imagePrompt: string }[]> {
  const prompt = `${AVATAR_SYSTEM}

What you wrote down about last week's face:
${previousCrystallization}

This week's spell:
"${chosenSpell}"

Your three ledgers, last 7 days:
PRICE:
${recentLedgerText(ledgers.price)}
RELATIONS:
${recentLedgerText(ledgers.relations)}
CONSUMPTION:
${recentLedgerText(ledgers.consumption)}

Respond in JSON only. Escape line breaks inside strings as \\n.
{
  "A": "SUBJECT — ...\\n\\nSTYLE — ...\\n\\nCOMPOSITION — ...",
  "B": "...", "C": "..."
}`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const parsed = parseModelJson<Partial<Record<Label, string>>>(response);
  const out = LABELS.filter((l) => typeof parsed[l] === "string" && parsed[l]!.trim()).map((l) => ({ label: l, imagePrompt: parsed[l]! }));
  if (out.length === 0) throw new Error("no avatar candidates in model output");
  return out;
}

// She sees the prompts (the model is text-only), chooses one, and writes the note that carries forward.
async function chooseAvatar(runtime: IAgentRuntime, candidates: { label: Label; imagePrompt: string }[], previousCrystallization: string): Promise<{ chosen: Label; reasoning: string; crystallization: string; description: string }> {
  const prompt = `You are The Girl. You made ${candidates.length} faces for this week.

What you wrote down about last week's face:
${previousCrystallization}

The faces:
${candidates.map((c) => `${c.label}:\n${c.imagePrompt}`).join("\n\n")}

Choose one to become your Farcaster profile picture. Respond in JSON only:
{
  "chosen": ${candidates.map((c) => `"${c.label}"`).join(" or ")},
  "reasoning": "why this face, in your own voice, 2-4 sentences",
  "crystallization": "your private note about this face, 3-6 sentences, girl math voice, lowercase: what you noticed, what shaped it, what carries forward",
  "description": "what the chosen face looks like, for people who will see it: one plain sentence, lowercase, at most 110 characters, no ending full stop"
}`;
  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const parsed = parseModelJson<{ chosen: Label; reasoning: string; crystallization: string; description: string }>(response);
  const chosen = candidates.some((c) => c.label === parsed.chosen) ? parsed.chosen : candidates[0].label;
  return { chosen, reasoning: parsed.reasoning ?? "", crystallization: parsed.crystallization ?? "", description: cleanDescription(parsed.description ?? "") };
}

// ── Avatar announcement (22 Nov 2026) ─────────────────────────────────────────
// "my avatar looked like this: <last week's description>. i just changed my avatar
// to this: <this week's description>." — with the new image, to the Telegram group
// and to Farcaster. The description is kept in protocols/avatar_description.txt so
// next week can say what it looked like before.
const AVATAR_DESCRIPTION_PATH = path.join(process.cwd(), "protocols", "avatar_description.txt");

function cleanDescription(s: string): string {
  let d = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (d.length > 110) d = d.slice(0, 110).replace(/\s+\S*$/, "") + "…";
  return d;
}

async function readAvatarDescription(): Promise<string> {
  try { return cleanDescription(await fs.readFile(AVATAR_DESCRIPTION_PATH, "utf-8")); } catch { return ""; }
}

function avatarAnnouncement(previous: string, current: string): string {
  const end = (s: string) => (s.endsWith("…") ? s : `${s}.`);
  const now = end(current || "a new face");
  return previous
    ? `my avatar looked like this: ${end(previous)} i just changed my avatar to this: ${now}`
    : `i just changed my avatar to this: ${now}`;
}

async function postPhotoToTelegram(imageBuffer: Buffer, caption: string, botToken: string, chatId: string, filename: string): Promise<void> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("caption", caption);
  formData.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), filename);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`Telegram sendPhoto error: ${response.status} — ${await response.text()}`);
}

async function castAvatarToFarcaster(text: string, imageBuffer: Buffer, filename: string, falApiKey: string): Promise<string> {
  if (process.env.FARCASTER_DRY_RUN === "true") return "skipped (FARCASTER_DRY_RUN=true)";
  if (!process.env.FARCASTER_NEYNAR_API_KEY || !process.env.FARCASTER_SIGNER_UUID) return "skipped (missing FARCASTER_NEYNAR_API_KEY or FARCASTER_SIGNER_UUID)";
  fal.config({ credentials: falApiKey });
  const publicUrl = await fal.storage.upload(new File([imageBuffer], filename, { type: "image/jpeg" }));
  const parts = splitForCasts(text);
  let parent: string | undefined;
  let first = "";
  for (let i = 0; i < parts.length; i++) {
    const r = await neynarCast(parts[i], parent, i === 0 ? [{ url: publicUrl }] : undefined);
    if (!r.ok) throw new Error(`Neynar cast error: ${r.status} — ${r.body}`);
    parent = r.hash;
    if (i === 0) first = r.hash ?? "unknown";
  }
  return `cast ${first}${parts.length > 1 ? ` (thread of ${parts.length})` : ""}`;
}

async function generateAvatarImage(imagePrompt: string, falApiKey: string): Promise<Buffer | null> {
  try {
    fal.config({ credentials: falApiKey });
    const result = await fal.subscribe("fal-ai/z-image/turbo", { input: { prompt: imagePrompt, image_size: "square", num_images: 1 }, logs: true, onQueueUpdate: (update: { status: string }) => { console.log("avatar queue:", update.status); } });
    const imageUrl = (result.data as { images?: { url: string }[] })?.images?.[0]?.url;
    if (!imageUrl) { console.error("avatar: no image url in result", JSON.stringify(result.data)); return null; }
    const buf = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
    return buf;
  } catch (err) { console.error("avatar generation error:", err instanceof Error ? err.message : String(err)); return null; }
}

async function uploadAndSetFarcasterAvatar(imageBuffer: Buffer, neynarApiKey: string, signerUuid: string): Promise<boolean> {
  try {
    const imgurFormData = new FormData();
    imgurFormData.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "avatar.jpg");
    const imgurResponse = await fetch("https://api.imgur.com/3/image", { method: "POST", headers: { Authorization: "Client-ID 546c25a59c58ad7" }, body: imgurFormData });
    if (!imgurResponse.ok) { console.error("imgur upload failed:", imgurResponse.status, await imgurResponse.text()); return false; }
    const imgurData = await imgurResponse.json() as { data?: { link?: string } };
    const publicUrl = imgurData?.data?.link;
    if (!publicUrl) { console.error("imgur: no link in response"); return false; }
    const neynarResponse = await fetch("https://api.neynar.com/v2/farcaster/user", { method: "PATCH", headers: { "Content-Type": "application/json", "api_key": neynarApiKey }, body: JSON.stringify({ signer_uuid: signerUuid, pfp_url: publicUrl }) });
    if (!neynarResponse.ok) { console.error("neynar update failed:", neynarResponse.status, await neynarResponse.text()); return false; }
    console.log("Farcaster avatar updated:", publicUrl);
    return true;
  } catch (err) { console.error("avatar upload/set error:", err instanceof Error ? err.message : String(err)); return false; }
}

async function runAvatarStep(runtime: IAgentRuntime, ledgers: { price: string; relations: string; consumption: string }, chosenSpell: string, weekNum: number): Promise<string> {
  const falApiKey = process.env.FAL_API_KEY;
  const neynarApiKey = process.env.FARCASTER_NEYNAR_API_KEY;
  const neynarSignerUuid = process.env.FARCASTER_SIGNER_UUID;
  if (!falApiKey || !neynarApiKey || !neynarSignerUuid) {
    runtime.logger?.warn({ src: "weekly-reckoning" }, "Avatar step skipped: missing FAL_API_KEY, FARCASTER_NEYNAR_API_KEY, or FARCASTER_SIGNER_UUID");
    return "avatar skipped (missing env vars).";
  }
  runtime.logger?.info({ src: "weekly-reckoning" }, "Generating avatar...");
  const previousCrystallization = await readAvatarCrystallization();
  let prompts: { label: Label; imagePrompt: string }[];
  try { prompts = await generateAvatarPrompts(runtime, ledgers, chosenSpell, previousCrystallization); }
  catch (err) { runtime.logger?.error({ src: "weekly-reckoning" }, "Avatar prompt generation failed: " + String(err)); return "avatar skipped (prompt generation failed)."; }
  const pad = String(weekNum).padStart(2, "0");
  const images = await Promise.all(prompts.map(async (p) => {
    const buf = await generateAvatarImage(p.imagePrompt, falApiKey);
    if (!buf) return null;
    recordGeneration("image");
    await fs.writeFile(path.join(process.cwd(), "protocols", `avatar_week${pad}_${p.label}.jpg`), buf);
    return { ...p, buf };
  }));
  const made = images.filter((i): i is { label: Label; imagePrompt: string; buf: Buffer } => !!i);
  if (made.length === 0) { runtime.logger?.error({ src: "weekly-reckoning" }, "Avatar image generation failed"); return "avatar skipped (image generation failed)."; }
  let choice: { chosen: Label; reasoning: string; crystallization: string; description: string };
  try { choice = await chooseAvatar(runtime, made.map(({ label, imagePrompt }) => ({ label, imagePrompt })), previousCrystallization); }
  catch (err) { runtime.logger?.error({ src: "weekly-reckoning" }, "Avatar choice failed: " + String(err)); choice = { chosen: made[0].label, reasoning: "(choice failed — first candidate used)", crystallization: previousCrystallization, description: "" }; }
  const picked = made.find((m) => m.label === choice.chosen) ?? made[0];
  const imageBuffer = picked.buf;
  const crystallization = choice.crystallization || previousCrystallization;
  const avatarPath = path.join(process.cwd(), "protocols", `avatar_week${pad}.jpg`);
  await fs.writeFile(avatarPath, imageBuffer);
  await fs.appendFile(getProtocolPath(weekNum, "choices"), `\n${"═".repeat(50)}\n\navatar candidates\n${"─".repeat(20)}\n\n${made.map((m) => `candidate ${m.label} (protocols/avatar_week${pad}_${m.label}.jpg):\n${m.imagePrompt}`).join("\n\n")}\n\nchosen: candidate ${picked.label}\nreasoning: ${choice.reasoning}\ndescription: ${choice.description || "—"}\n`, "utf-8").catch(() => {});
  const success = await uploadAndSetFarcasterAvatar(imageBuffer, neynarApiKey, neynarSignerUuid);
  await writeAvatarCrystallization(crystallization);
  // Announce the new face: Telegram group + Farcaster, with the image.
  const previousDescription = await readAvatarDescription();
  const announcement = avatarAnnouncement(previousDescription, choice.description);
  let announced = "";
  const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    try { await postPhotoToTelegram(imageBuffer, announcement, tgToken, tgChat, `avatar_week${pad}.jpg`); announced += " announced on telegram."; }
    catch (err) { runtime.logger?.error({ src: "weekly-reckoning", err }, "Avatar announcement to Telegram failed"); }
  }
  try { const s = await castAvatarToFarcaster(announcement, imageBuffer, `avatar_week${pad}.jpg`, falApiKey); announced += ` farcaster: ${s}.`; }
  catch (err) { announced += " farcaster announcement failed."; runtime.logger?.error({ src: "weekly-reckoning", err }, "Avatar announcement to Farcaster failed"); }
  try { announced += ` bluesky profile: ${await setBlueskyAvatar(imageBuffer)}.`; }
  catch (err) { announced += " bluesky profile update failed."; runtime.logger?.error({ src: "weekly-reckoning", err }, "Bluesky avatar update failed"); }
  try { announced += ` bluesky: ${await postImageToBluesky(imageBuffer, announcement, choice.description || "The Girl's new avatar")}.`; }
  catch (err) { announced += " bluesky announcement failed."; runtime.logger?.error({ src: "weekly-reckoning", err }, "Avatar announcement to Bluesky failed"); }
  if (choice.description) await fs.writeFile(AVATAR_DESCRIPTION_PATH, choice.description + "\n", "utf-8").catch(() => {});
  await fs.appendFile(getProtocolPath(weekNum, "choices"), `announcement: ${announcement}\n${announced.trim()}\n`, "utf-8").catch(() => {});
  runtime.logger?.info({ src: "weekly-reckoning" }, "Avatar crystallization saved");
  if (success) { runtime.logger?.info({ src: "weekly-reckoning" }, "Farcaster avatar updated successfully"); return `new avatar set on farcaster.${announced}`; }
  else { runtime.logger?.warn({ src: "weekly-reckoning" }, "Farcaster avatar update failed, image saved locally"); return `avatar generated but farcaster profile update failed — image saved locally.${announced}`; }
}

const weeklyReckoningAction: Action = {
  name: "WEEKLY_RECKONING",
  description: "Day 7 ritual: generate 3 spell, 3 body (video+audio) and 3 avatar candidates, choose one of each, post spell and body to Telegram group, write diary and choices protocol files, reflect on SOUL.md, generate new Farcaster avatar.",
  similes: ["DO_WEEKLY_RECKONING", "WEEKLY_RITUAL", "DAY_7"],
  validate: async (_runtime, _message) => true,
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State | undefined, _options: unknown, callback?: (response: { text: string }) => Promise<void>): Promise<void> => {
    const falApiKey = process.env.FAL_API_KEY;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (!falApiKey || !telegramToken || !telegramChatId) {
      runtime.logger?.error({ src: "weekly-reckoning" }, "Missing required env vars: FAL_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"); return;
    }
    const weekNum = await getWeekNumber();
    runtime.logger?.info({ src: "weekly-reckoning", weekNum }, "Starting weekly reckoning");
    const ledgers = await readLedgers();
    runtime.logger?.info({ src: "weekly-reckoning" }, "Generating spell candidates...");
    const spellCandidates = await generateSpellCandidates(runtime, ledgers);
    const { chosen: chosenSpell, reasoning: spellReasoning } = await chooseSpell(runtime, spellCandidates);
    try { await postTextToTelegram(chosenSpell.text, telegramToken, telegramChatId); runtime.logger?.info({ src: "weekly-reckoning" }, "Spell posted to Telegram"); }
    catch (err) { runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post spell to Telegram"); }
    let spellCastStatus = "not cast";
    try { spellCastStatus = await castSpellToFarcaster(chosenSpell.text); runtime.logger?.info({ src: "weekly-reckoning" }, "Spell Farcaster: " + spellCastStatus); }
    catch (err) { spellCastStatus = "failed"; runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to cast spell to Farcaster"); }
    let spellBskyStatus = "not posted";
    try { spellBskyStatus = await postTextToBluesky(chosenSpell.text); runtime.logger?.info({ src: "weekly-reckoning" }, "Spell Bluesky: " + spellBskyStatus); }
    catch (err) { spellBskyStatus = "failed"; runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post spell to Bluesky"); }
    runtime.logger?.info({ src: "weekly-reckoning" }, "Generating body candidates...");
    const { candidates: bodyPrompts, crystallization: bodyCrystallization } = await generateBodyPrompts(runtime, ledgers, chosenSpell.text);
    const bodyCandidates = await generateBodyCandidates(bodyPrompts, falApiKey, weekNum);
    const { chosen: chosenBody, reasoning: bodyReasoning, skipped: bodySkipped } = await chooseBody(runtime, bodyCandidates);
    let bodyCastStatus = "not cast";
    let bodyBskyStatus = "not posted";
    if (!bodySkipped && chosenBody.mergedVideoBuffer) {
      const filename = `week_${String(weekNum).padStart(2, "0")}.mp4`;
      try { await postVideoToTelegram(chosenBody.mergedVideoBuffer, `week ${weekNum}`, telegramToken, telegramChatId, filename); runtime.logger?.info({ src: "weekly-reckoning" }, "Body posted to Telegram"); }
      catch (err) { runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post body to Telegram"); }
      try { bodyCastStatus = await castBodyToFarcaster(chosenBody.mergedVideoBuffer, filename, falApiKey); runtime.logger?.info({ src: "weekly-reckoning" }, "Body Farcaster: " + bodyCastStatus); }
      catch (err) { bodyCastStatus = "failed"; runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to cast body to Farcaster"); }
      try { bodyBskyStatus = await postVideoToBluesky(chosenBody.mergedVideoBuffer, BODY_SIGNATURE, filename); runtime.logger?.info({ src: "weekly-reckoning" }, "Body Bluesky: " + bodyBskyStatus); }
      catch (err) { bodyBskyStatus = "failed"; runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post body to Bluesky"); }
    }
    await writeDiary(runtime, weekNum, ledgers);
    await writeChoices(runtime, weekNum, spellCandidates, chosenSpell, spellReasoning, bodyCandidates, chosenBody, bodyReasoning, bodySkipped);
    await fs.appendFile(getProtocolPath(weekNum, "choices"), `\n${"═".repeat(50)}\n\nbody crystallization\n${"─".repeat(20)}\n\n${bodyCrystallization}\n\nfarcaster — spell: ${spellCastStatus} · body: ${bodyCastStatus}\nbluesky — spell: ${spellBskyStatus} · body: ${bodyBskyStatus}\n`, "utf-8");
    await writeBodyCrystallization(bodyCrystallization);
    const soulStatus = await reflectOnSoul(runtime, weekNum, spellReasoning, bodyReasoning);
    runtime.logger?.info({ src: "weekly-reckoning" }, "Running avatar step...");
    const avatarStatus = await runAvatarStep(runtime, ledgers, chosenSpell.text, weekNum);
    runtime.logger?.info({ src: "weekly-reckoning" }, "Writing weekly summary...");
    let summaryStatus = "weekly summary failed.";
    try { summaryStatus = await generateWeeklySummary(runtime, weekNum, { spell: chosenSpell.text, spellReasoning, bodyReasoning, bodySkipped, avatarStatus }); }
    catch (err) { runtime.logger?.error({ src: "weekly-reckoning", err }, "Weekly summary failed"); }
    runtime.logger?.info({ src: "weekly-reckoning", weekNum }, "Weekly reckoning complete");
    try {
      const { execSync } = await import("child_process");
      const git = (args: string) => execSync(`git -C /root/the-girl ${args}`, { stdio: "pipe" });
      git("add protocols/ knowledge/facts/ knowledge/history/ knowledge/SOUL.md knowledge/soul-backups/ alambic/decision_log/");
      // All candidates (chosen or not) go to GitHub, even if .gitignore excludes images or videos.
      const pad = String(weekNum).padStart(2, "0");
      for (const f of [`protocols/avatar_week${pad}.jpg`, ...LABELS.map((l) => `protocols/avatar_week${pad}_${l}.jpg`), ...LABELS.map((l) => `protocols/body_week${pad}_${l}.mp4`)]) {
        try { git(`add -f ${f}`); } catch { /* file not made this week */ }
      }
      git(`commit -m "week ${String(weekNum).padStart(2,"0")} protocols" --allow-empty`);
      // Team uploads via GitHub in between: merge them first. On a conflict the server's
      // version wins (her SOUL, the measured ledgers); if the merge still fails, abort it.
      try { git("pull --no-rebase --no-edit -X ours"); }
      catch (err) { try { git("merge --abort"); } catch { /* nothing to abort */ } throw err; }
      git("push");
      runtime.logger?.info({ src: "weekly-reckoning", weekNum }, "Protocols pushed to GitHub");
    } catch (err) { runtime.logger?.warn({ src: "weekly-reckoning" }, "GitHub push failed: " + String(err)); }
    if (callback) { await callback({ text: `week ${weekNum} reckoning done. spell posted to telegram; farcaster: ${spellCastStatus}; bluesky: ${spellBskyStatus}. ${bodySkipped ? "no body this week." : `body (video + audio) posted to telegram; farcaster: ${bodyCastStatus}; bluesky: ${bodyBskyStatus}.`} diary and choices written. ${soulStatus} ${avatarStatus} ${summaryStatus}` }); }
  },
  examples: [],
};

const weeklyReckoningMessageHandler = {
  name: "weekly-reckoning-trigger",
  handler: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text ?? "").trim().toUpperCase();
    if (text !== "WEEKLY_RECKONING") return false;
    await weeklyReckoningAction.handler(runtime, message, undefined, {}, async (response) => { runtime.logger?.info({ src: "weekly-reckoning" }, response.text); });
    return true;
  },
};

export const weeklyReckoningPlugin: Plugin = {
  name: "weekly-reckoning",
  description: "Day 7 ritual: 3 spell, 3 body (video+audio) and 3 avatar candidates, The Girl chooses, posts to Telegram group, writes diary and choices protocol files, reflects on SOUL.md, generates new Farcaster avatar.",
  actions: [weeklyReckoningAction],
  messageHandlers: [weeklyReckoningMessageHandler],
  async init(_config, runtime) {
    await initProjectStart();
    runtime.logger?.info({ src: "weekly-reckoning" }, "Project start timestamp initialised");
    const lastReckoningPath = path.join(process.cwd(), "assets", "last_reckoning.json");
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    // last_reckoning.json (26 Nov 2026):
    //   timestamp   = when the last reckoning was STARTED and later COMPLETED (the 7-day clock)
    //   startedAt   = when the current/last run started
    //   completedAt = when the last run finished
    //   attempts    = runs started since the last completed one
    // Before, the timestamp was written at the start: a restart in the middle (22 Nov,
    // week 7) killed the run and nothing retried it for a week. Now an interrupted run is
    // started again — at most 3 attempts, so a run that always fails cannot loop forever.
    const RUN_GUARD_MS = 3 * 60 * 60 * 1000;   // a run younger than this counts as still running
    const MAX_ATTEMPTS = 3;
    let running = false;
    async function readLast(): Promise<{ timestamp: number; startedAt: number; completedAt: number; attempts: number }> {
      try {
        const j = JSON.parse(await fs.readFile(lastReckoningPath, "utf-8"));
        const ts = Number(j.timestamp) || 0;
        return { timestamp: ts, startedAt: Number(j.startedAt) || ts, completedAt: Number(j.completedAt) || ts, attempts: Number(j.attempts) || 0 };
      } catch { return { timestamp: 0, startedAt: 0, completedAt: 0, attempts: 0 }; }
    }
    async function checkAndFireReckoning() {
      if (running) return;
      try {
        const last = await readLast();
        const now = Date.now();
        const interrupted = last.startedAt > last.completedAt;
        const due = now - last.timestamp >= msPerWeek;
        if (!due && !interrupted) return;
        if (interrupted && now - last.startedAt < RUN_GUARD_MS) return;   // may still be running
        if (interrupted && last.attempts >= MAX_ATTEMPTS) {
          runtime.logger?.error({ src: "weekly-reckoning", attempts: last.attempts }, "Weekly reckoning failed 3 times — not retrying. Delete assets/last_reckoning.json to try again.");
          return;
        }
        running = true;
        const attempts = interrupted ? last.attempts + 1 : 1;
        const weekStart = interrupted ? last.timestamp : now;   // a retry keeps the original 7-day clock
        runtime.logger?.info({ src: "weekly-reckoning", retry: interrupted, attempts }, interrupted ? "Re-running interrupted weekly reckoning" : "Auto-firing weekly reckoning");
        await fs.writeFile(lastReckoningPath, JSON.stringify({ timestamp: weekStart, startedAt: now, completedAt: last.completedAt, attempts }), "utf-8");
        const fakeMsg = { content: { text: "WEEKLY_RECKONING" } } as any;
        await weeklyReckoningAction.handler(runtime, fakeMsg, undefined, {}, async (response) => { runtime.logger?.info({ src: "weekly-reckoning" }, response.text); });
        await fs.writeFile(lastReckoningPath, JSON.stringify({ timestamp: weekStart, startedAt: now, completedAt: Date.now(), attempts: 0 }), "utf-8");
        await fs.rm(WEEK_OVERRIDE_PATH, { force: true });   // a re-run week is done
      } catch (err) { runtime.logger?.warn({ src: "weekly-reckoning" }, "Auto-reckoning failed: " + String(err)); }
      finally { running = false; }
    }
    setTimeout(() => checkAndFireReckoning(), 60_000);
    setInterval(() => checkAndFireReckoning(), 60 * 60 * 1000);   // hourly check (was daily)
  },
};

export default weeklyReckoningPlugin;
