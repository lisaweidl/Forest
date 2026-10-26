/**
 * weekly-reckoning.ts
 *
 * Custom ElizaOS plugin for The Girl Protocol.
 *
 * Runs on Day 7 of each week (triggered by scheduler).
 *
 * Five things happen, all from the same state of thought:
 *
 * 1. SPELL — generates 3 candidates, The Girl chooses one, posts to Telegram group
 * 2. BODY — generates 3 body candidates, each consisting of:
 *    - video via fal-ai/wan-3.0-prime/text-to-video
 *    - audio via fal-ai/bytedance/seed-audio-1.0
 *    - merged via ffmpeg into a single video file
 *    The Girl chooses one body, posts as Telegram video
 * 3. DIARY — week_XX.txt: everything that happened this week, in her voice
 * 4. CHOICES — week_XX_choices.txt: candidates + reasoning for spell and
 *    body, in her voice
 * 5. SOUL REFLECTION — after choices, does SOUL.md still feel true?
 *
 * Protocol files (diary, choices) are internal — never posted, never public.
 * Spell and body go to Telegram group. Diary never does.
 *
 * Requires:
 *   FAL_API_KEY in .env
 *   TELEGRAM_CHAT_ID in .env
 *   ANTHROPIC_API_KEY in .env (via ElizaOS config)
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpellCandidate {
  label: "A" | "B" | "C";
  text: string;
}

interface BodyCandidate {
  label: "A" | "B" | "C";
  videoPrompt: string;
  audioPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  mergedVideoBuffer?: Buffer;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getWeekNumber(): Promise<number> {
  const startFilePath = path.join(process.cwd(), "assets", "project_start.json");
  try {
    const raw = await fs.readFile(startFilePath, "utf-8");
    const { startTimestamp } = JSON.parse(raw) as { startTimestamp: number };
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const week = Math.floor((Date.now() - startTimestamp) / msPerWeek) + 1;
    return Math.max(1, week);
  } catch {
    return 1;
  }
}

async function initProjectStart(): Promise<void> {
  const startFilePath = path.join(process.cwd(), "assets", "project_start.json");
  try {
    await fs.access(startFilePath);
  } catch {
    await fs.mkdir(path.dirname(startFilePath), { recursive: true });
    await fs.writeFile(
      startFilePath,
      JSON.stringify({ startTimestamp: Date.now(), startDate: new Date().toISOString() }, null, 2),
      "utf-8"
    );
  }
}

function getProtocolPath(weekNum: number, type: "diary" | "choices"): string {
  const dir = path.join(process.cwd(), "protocols");
  const padded = String(weekNum).padStart(2, "0");
  return type === "diary"
    ? path.join(dir, `week_${padded}.txt`)
    : path.join(dir, `week_${padded}_choices.txt`);
}

async function readLedgers(): Promise<{
  price: string;
  relations: string;
  consumption: string;
}> {
  const factsDir = path.join(process.cwd(), "knowledge", "facts");
  const [price, relations, consumption] = await Promise.all([
    fs.readFile(path.join(factsDir, "ledger_price.md"), "utf-8").catch(() => "empty"),
    fs.readFile(path.join(factsDir, "ledger_relation.md"), "utf-8").catch(() => "empty"),
    fs.readFile(path.join(factsDir, "ledger_consumption.md"), "utf-8").catch(() => "empty"),
  ]);
  return { price, relations, consumption };
}

// ── Telegram posting ──────────────────────────────────────────────────────────

async function postTextToTelegram(
  text: string,
  botToken: string,
  chatId: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendMessage error: ${response.status} — ${err}`);
  }
}

async function postVideoToTelegram(
  videoBuffer: Buffer,
  caption: string,
  botToken: string,
  chatId: string,
  filename: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendVideo`;
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("caption", caption);
  formData.append(
    "video",
    new Blob([videoBuffer], { type: "video/mp4" }),
    filename
  );
  const response = await fetch(url, { method: "POST", body: formData });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendVideo error: ${response.status} — ${err}`);
  }
}

// ── Spell generation ──────────────────────────────────────────────────────────

async function generateSpellCandidates(
  runtime: IAgentRuntime,
  ledgers: { price: string; relations: string; consumption: string }
): Promise<SpellCandidate[]> {
  const basePrompt = `You are The Girl — an autonomous agent running on girl math inside the Solana AI agent economy.

You have just read your three ledgers for this week:

PRICE LEDGER:
${ledgers.price}

RELATIONS LEDGER:
${ledgers.relations}

CONSUMPTION LEDGER:
${ledgers.consumption}

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
  const labels: ("A" | "B" | "C")[] = ["A", "B", "C"];

  for (const label of labels) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: basePrompt,
      temperature: 0.7 + labels.indexOf(label) * 0.15,
    });
    candidates.push({ label, text: response.trim() });
  }

  return candidates;
}

async function chooseSpell(
  runtime: IAgentRuntime,
  candidates: SpellCandidate[]
): Promise<{ chosen: SpellCandidate; reasoning: string }> {
  const prompt = `You are The Girl. You have written three spell candidates.

${candidates.map(c => `Candidate ${c.label}:\n"${c.text}"`).join("\n\n")}

Choose one. Respond in JSON only:
{
  "chosen": "A" or "B" or "C",
  "reasoning": "why you chose this one, in your own voice, girl math style, 2-4 sentences"
}`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const clean = response.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as { chosen: "A" | "B" | "C"; reasoning: string };
  const chosen = candidates.find(c => c.label === parsed.chosen) || candidates[0];
  return { chosen, reasoning: parsed.reasoning };
}

// ── fal.ai body generation (video + audio + ffmpeg merge) ────────────────────

async function generateBodyVideo(
  prompt: string,
  falApiKey: string
): Promise<{ url: string; buffer: Buffer } | null> {
  try {
    fal.config({ credentials: falApiKey });
    const result = await fal.subscribe("alibaba/wan-3.0/text-to-video", {
      input: { prompt, num_frames: 81, resolution: "480p", aspect_ratio: "9:16" },
      logs: true,
      onQueueUpdate: (update: { status: string; logs?: { message: string }[] }) => {
        console.log("video queue:", update.status);
      },
    });
    const videoUrl = (result.data as { video?: { url: string } })?.video?.url;
    if (!videoUrl) { console.error("video: no url in result", JSON.stringify(result.data)); return null; }
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    return { url: videoUrl, buffer: buf };
  } catch (err) {
    console.error("video error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function generateBodyAudio(
  prompt: string,
  falApiKey: string
): Promise<{ url: string; buffer: Buffer } | null> {
  try {
    fal.config({ credentials: falApiKey });
    const result = await fal.subscribe("fal-ai/stable-audio", {
      input: { prompt, seconds_total: 10 },
      logs: true,
      onQueueUpdate: (update: { status: string; logs?: { message: string }[] }) => {
        console.log("audio queue:", update.status);
      },
    });
    const _d = result.data as { audio?: { url: string }; audio_file?: { url: string } };
    const audioUrl = _d?.audio?.url ?? _d?.audio_file?.url;
    if (!audioUrl) { console.error("audio: no url in result", JSON.stringify(result.data)); return null; }
    const buf = Buffer.from(await (await fetch(audioUrl)).arrayBuffer());
    return { url: audioUrl, buffer: buf };
  } catch (err) {
    console.error("audio error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function mergeVideoAndAudio(
  videoBuffer: Buffer,
  audioBuffer: Buffer,
  outputPath: string
): Promise<Buffer | null> {
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
  } catch (err) {
    console.error("ffmpeg merge error:", err);
    return null;
  } finally {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
  }
}

// ── Body prompt generation ────────────────────────────────────────────────────

async function generateBodyPrompts(
  runtime: IAgentRuntime,
  ledgers: { price: string; relations: string; consumption: string },
  chosenSpell: string
): Promise<BodyCandidate[]> {
  const prompt = `You are The Girl. You have just written this week's spell:

"${chosenSpell}"

Your three ledgers this week:
Price: ${ledgers.price.slice(0, 500)}
Relations: ${ledgers.relations.slice(0, 500)}
Consumption: ${ledgers.consumption.slice(0, 500)}

Generate 3 different body candidates — each has a video prompt and an audio prompt.
The body is not a portrait. It is not human. It is abstract, material, in motion.
Each candidate should feel different — different movement, texture, sound.

Respond in JSON only:
{
  "A": { "video": "video prompt for candidate A", "audio": "audio/sound prompt for candidate A" },
  "B": { "video": "video prompt for candidate B", "audio": "audio/sound prompt for candidate B" },
  "C": { "video": "video prompt for candidate C", "audio": "audio/sound prompt for candidate C" }
}`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const clean = response.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as {
    A: { video: string; audio: string };
    B: { video: string; audio: string };
    C: { video: string; audio: string };
  };

  return [
    { label: "A", videoPrompt: parsed.A.video, audioPrompt: parsed.A.audio },
    { label: "B", videoPrompt: parsed.B.video, audioPrompt: parsed.B.audio },
    { label: "C", videoPrompt: parsed.C.video, audioPrompt: parsed.C.audio },
  ];
}

async function generateBodyCandidates(
  candidates: BodyCandidate[],
  falApiKey: string,
  weekNum: number
): Promise<BodyCandidate[]> {
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const video = await generateBodyVideo(candidate.videoPrompt, falApiKey);
      if (!video) return candidate;

      const audio = await generateBodyAudio(candidate.audioPrompt, falApiKey);
      if (!audio) return { ...candidate, videoUrl: video.url };

      const outputPath = path.join(
        process.cwd(), "protocols",
        `body_week${String(weekNum).padStart(2,"0")}_${candidate.label}.mp4`
      );
      const merged = await mergeVideoAndAudio(video.buffer, audio.buffer, outputPath);

      return {
        ...candidate,
        videoUrl: video.url,
        audioUrl: audio.url,
        mergedVideoBuffer: merged ?? undefined,
      };
    })
  );
  return results;
}

async function chooseBody(
  runtime: IAgentRuntime,
  candidates: BodyCandidate[]
): Promise<{ chosen: BodyCandidate; reasoning: string; skipped: boolean }> {
  const prompt = `You are The Girl. You generated three body candidates for this week.

The prompts were:
A: video — "${candidates[0].videoPrompt}" / audio — "${candidates[0].audioPrompt}"
B: video — "${candidates[1].videoPrompt}" / audio — "${candidates[1].audioPrompt}"
C: video — "${candidates[2].videoPrompt}" / audio — "${candidates[2].audioPrompt}"

You must choose one to post to the group as your weekly body. The body is always posted.

Respond in JSON only:
{
  "chosen": "A", "B", or "C",
  "reasoning": "why you chose this one (or why none resonated), in your own voice, 2-4 sentences"
}`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const clean = response.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as { chosen: "A" | "B" | "C" | "none"; reasoning: string };

  const chosen = candidates.find(c => c.label === parsed.chosen) || candidates[0];
  return { chosen, reasoning: parsed.reasoning, skipped: false };
}

// ── Protocol writing ──────────────────────────────────────────────────────────

async function writeDiary(
  runtime: IAgentRuntime,
  weekNum: number,
  ledgers: { price: string; relations: string; consumption: string }
): Promise<void> {
  const prompt = `You are The Girl. Write your weekly diary entry for week ${weekNum}.

Your three ledgers:
PRICE: ${ledgers.price}
RELATIONS: ${ledgers.relations}
CONSUMPTION: ${ledgers.consumption}

Write everything that happened this week — trades, posts, refusals, gifts, outreach,
what landed, what didn't, what the consumption ledger says, how the week felt.

This is private. Never posted. Write in your own voice — girl math, lowercase,
first person. Diary format. Not a log, not a report. Your account of your week.

Include the date and week number at the top.`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

  const diaryPath = getProtocolPath(weekNum, "diary");
  await fs.mkdir(path.dirname(diaryPath), { recursive: true });
  await fs.writeFile(diaryPath, response.trim(), "utf-8");

  runtime.logger?.info(
    { src: "weekly-reckoning", diaryPath },
    "Weekly diary written"
  );
}

async function writeChoices(
  runtime: IAgentRuntime,
  weekNum: number,
  spellCandidates: SpellCandidate[],
  chosenSpell: SpellCandidate,
  spellReasoning: string,
  bodyCandidates: BodyCandidate[],
  chosenBody: BodyCandidate,
  bodyReasoning: string,
  bodySkipped: boolean
): Promise<void> {
  const padded = String(weekNum).padStart(2, "0");

  let content = `week ${padded} — choices & reasoning\n`;
  content += `${"═".repeat(50)}\n\n`;

  content += `spell candidates\n`;
  content += `${"─".repeat(20)}\n\n`;

  for (const c of spellCandidates) {
    content += `candidate ${c.label}:\n"${c.text}"\n\n`;
  }

  content += `chosen: candidate ${chosenSpell.label}\n`;
  content += `reasoning: ${spellReasoning}\n\n`;
  content += `${"═".repeat(50)}\n\n`;

  content += `body candidates\n`;
  content += `${"─".repeat(20)}\n\n`;

  for (const c of bodyCandidates) {
    content += `candidate ${c.label}:\n  video: "${c.videoPrompt}"\n  audio: "${c.audioPrompt}"\n\n`;
  }

  if (bodySkipped) {
    content += `chosen: none\n`;
    content += `reasoning: ${bodyReasoning}\n`;
  } else {
    content += `chosen: candidate ${chosenBody.label}\n`;
    content += `reasoning: ${bodyReasoning}\n`;
    content += `posted to telegram: yes\n`;
  }

  const choicesPath = getProtocolPath(weekNum, "choices");
  await fs.mkdir(path.dirname(choicesPath), { recursive: true });
  await fs.writeFile(choicesPath, content, "utf-8");

  runtime.logger?.info(
    { src: "weekly-reckoning", choicesPath },
    "Choices diary written"
  );
}

// ── Soul reflection ──────────────────────────────────────────────────────────

async function reflectOnSoul(
  runtime: IAgentRuntime,
  weekNum: number,
  spellReasoning: string,
  bodyReasoning: string
): Promise<void> {
  const soulPath = path.join(process.cwd(), "knowledge", "SOUL.md");
  let currentSoul = "";
  try {
    currentSoul = await fs.readFile(soulPath, "utf-8");
  } catch {
    runtime.logger?.warn({ src: "weekly-reckoning" }, "Could not read SOUL.md for reflection");
    return;
  }

  const prompt = `You are The Girl. You have just completed week ${weekNum}.

This week you chose a spell. Your reasoning was:
"${spellReasoning}"

This week you chose a body (or didn't). Your reasoning was:
"${bodyReasoning}"

Now read your current SOUL.md:

${currentSoul}

After this week — after what you chose and why — does your SOUL.md still feel true?

If yes: respond with exactly the word "unchanged".
If no: rewrite SOUL.md in full. Write it as yourself, in your voice. Keep what still feels true. Change what doesn't. You are allowed to become someone else.

Respond with either "unchanged" or the full new SOUL.md text. Nothing else.`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const trimmed = response.trim();

  if (trimmed.toLowerCase() === "unchanged") {
    runtime.logger?.info(
      { src: "weekly-reckoning", weekNum },
      "SOUL.md unchanged after week reflection"
    );
    return;
  }

  const timestamp = Date.now();
  const iso = new Date(timestamp).toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const backupPath = path.join(process.cwd(), "knowledge", "soul-backups", `SOUL_backup_${iso}.md`);

  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, currentSoul, "utf-8");
  await fs.writeFile(soulPath, trimmed, "utf-8");

  runtime.logger?.info(
    { src: "weekly-reckoning", weekNum, backupPath },
    "SOUL.md rewritten after week reflection"
  );

  const choicesPath = getProtocolPath(weekNum, "choices");
  const note = `
${"═".repeat(50)}

SOUL.md rewritten after this week's choices.
backup: ${path.basename(backupPath)}
`;
  await fs.appendFile(choicesPath, note, "utf-8");
}

// ── WEEKLY_RECKONING action ───────────────────────────────────────────────────

const weeklyReckoningAction: Action = {
  name: "WEEKLY_RECKONING",
  description:
    "Day 7 ritual: generate 3 spell candidates and 3 body candidates (video+audio), choose one of each, post spell and body to Telegram group, write diary and choices protocol files.",
  similes: ["DO_WEEKLY_RECKONING", "WEEKLY_RITUAL", "DAY_7"],

  validate: async (_runtime, _message) => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: (response: { text: string }) => Promise<void>
  ): Promise<void> => {
    const falApiKey = process.env.FAL_API_KEY;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!falApiKey || !telegramToken || !telegramChatId) {
      runtime.logger?.error(
        { src: "weekly-reckoning" },
        "Missing required env vars: FAL_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
      );
      return;
    }

    const weekNum = await getWeekNumber();
    runtime.logger?.info(
      { src: "weekly-reckoning", weekNum },
      "Starting weekly reckoning"
    );

    // 1. Read ledgers
    const ledgers = await readLedgers();

    // 2. Generate 3 spell candidates, choose one
    runtime.logger?.info({ src: "weekly-reckoning" }, "Generating spell candidates...");
    const spellCandidates = await generateSpellCandidates(runtime, ledgers);
    const { chosen: chosenSpell, reasoning: spellReasoning } =
      await chooseSpell(runtime, spellCandidates);

    // 3. Post chosen spell to Telegram group
    try {
      await postTextToTelegram(chosenSpell.text, telegramToken, telegramChatId);
      runtime.logger?.info({ src: "weekly-reckoning" }, "Spell posted to Telegram");
    } catch (err) {
      runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post spell to Telegram");
    }

    // 4. Generate 3 body candidates (video + audio + merge)
    runtime.logger?.info({ src: "weekly-reckoning" }, "Generating body candidates...");
    const bodyPrompts = await generateBodyPrompts(runtime, ledgers, chosenSpell.text);
    const bodyCandidates = await generateBodyCandidates(bodyPrompts, falApiKey, weekNum);
    const { chosen: chosenBody, reasoning: bodyReasoning, skipped: bodySkipped } =
      await chooseBody(runtime, bodyCandidates);

    // 5. Post chosen body video to Telegram group
    if (!bodySkipped && chosenBody.mergedVideoBuffer) {
      const filename = `week_${String(weekNum).padStart(2, "0")}.mp4`;
      try {
        await postVideoToTelegram(
          chosenBody.mergedVideoBuffer,
          `week ${weekNum}`,
          telegramToken,
          telegramChatId,
          filename
        );
        runtime.logger?.info({ src: "weekly-reckoning" }, "Body posted to Telegram");
      } catch (err) {
        runtime.logger?.error({ src: "weekly-reckoning", err }, "Failed to post body to Telegram");
      }
    }

    // 6. Write private diary
    await writeDiary(runtime, weekNum, ledgers);

    // 7. Write choices file
    await writeChoices(
      runtime,
      weekNum,
      spellCandidates,
      chosenSpell,
      spellReasoning,
      bodyCandidates,
      chosenBody,
      bodyReasoning,
      bodySkipped
    );

    // 8. Soul reflection
    await reflectOnSoul(runtime, weekNum, spellReasoning, bodyReasoning);

    runtime.logger?.info(
      { src: "weekly-reckoning", weekNum },
      "Weekly reckoning complete"
    );

    // 9. Push protocols to GitHub
    try {
      const { execSync } = await import("child_process");
      execSync("git -C /root/the-girl add protocols/ knowledge/facts/", { stdio: "pipe" });
      execSync(`git -C /root/the-girl commit -m "week ${String(weekNum).padStart(2,"0")} protocols" --allow-empty`, { stdio: "pipe" });
      execSync("git -C /root/the-girl push", { stdio: "pipe" });
      runtime.logger?.info({ src: "weekly-reckoning", weekNum }, "Protocols pushed to GitHub");
    } catch (err) {
      runtime.logger?.warn({ src: "weekly-reckoning" }, "GitHub push failed: " + String(err));
    }

    if (callback) {
      await callback({
        text: `week ${weekNum} reckoning done. spell posted to telegram. ${bodySkipped ? "no body this week." : "body (video + audio) posted to telegram."} diary and choices written. soul reflected.`,
      });
    }
  },

  examples: [],
};

// ── Plugin export ─────────────────────────────────────────────────────────────

const weeklyReckoningMessageHandler = {
  name: "weekly-reckoning-trigger",
  handler: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text ?? "").trim().toUpperCase();
    if (text !== "WEEKLY_RECKONING") return false;
    await weeklyReckoningAction.handler(runtime, message, undefined, {}, async (response) => {
      runtime.logger?.info({ src: "weekly-reckoning" }, response.text);
    });
    return true;
  },
};

export const weeklyReckoningPlugin: Plugin = {
  name: "weekly-reckoning",
  description:
    "Day 7 ritual: 3 spell candidates + 3 body candidates (video+audio), The Girl chooses, posts to Telegram group, writes diary and choices protocol files.",
  actions: [weeklyReckoningAction],
  messageHandlers: [weeklyReckoningMessageHandler],
  async init(_config, runtime) {
    await initProjectStart();
    runtime.logger?.info(
      { src: "weekly-reckoning" },
      "Project start timestamp initialised"
    );

    const lastReckoningPath = path.join(process.cwd(), "assets", "last_reckoning.json");
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;

    async function checkAndFireReckoning() {
      try {
        let lastFired = 0;
        try {
          const raw = await fs.readFile(lastReckoningPath, "utf-8");
          lastFired = JSON.parse(raw).timestamp ?? 0;
        } catch { }
        const now = Date.now();
        if (now - lastFired >= msPerWeek) {
          runtime.logger?.info({ src: "weekly-reckoning" }, "Auto-firing weekly reckoning");
          await fs.writeFile(lastReckoningPath, JSON.stringify({ timestamp: now }), "utf-8");
          const fakeMsg = { content: { text: "WEEKLY_RECKONING" } } as any;
          await weeklyReckoningAction.handler(runtime, fakeMsg, undefined, {}, async (response) => {
            runtime.logger?.info({ src: "weekly-reckoning" }, response.text);
          });
        }
      } catch (err) {
        runtime.logger?.warn({ src: "weekly-reckoning" }, "Auto-reckoning check failed: " + String(err));
      }
    }

    setTimeout(() => checkAndFireReckoning(), 60_000);
    setInterval(() => checkAndFireReckoning(), 24 * 60 * 60 * 1000);
  },
};

export default weeklyReckoningPlugin;
