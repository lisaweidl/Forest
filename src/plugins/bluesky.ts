/**
 * bluesky.ts — The Girl on Bluesky (22 Nov 2026)
 *
 * Not a plugin: helpers that weekly-reckoning.ts calls next to Farcaster.
 * Plain XRPC over fetch, no extra npm package.
 *
 *   postTextToBluesky(text)                 spell — one post, or a thread if > 300 characters
 *   postVideoToBluesky(video, text, name)   body — merged video + audio, with the signature
 *   postImageToBluesky(image, text, alt)    avatar announcement — with the new face
 *   setBlueskyAvatar(image)                 avatar — changes the profile picture
 *
 * .env (all optional — without handle + app password every call returns "skipped"):
 *   BLUESKY_HANDLE=the-girl.bsky.social
 *   BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   (an app password, never the account password)
 *   BLUESKY_SERVICE=https://bsky.social        (only if the account lives elsewhere)
 *   BLUESKY_DRY_RUN=true                       (log only, post nothing)
 *
 * Limits handled here: 300 characters per post (thread otherwise), images ≤ 1 MB
 * (re-encoded with ffmpeg if larger), videos via Bluesky's video service, with a
 * direct upload as fallback.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_GRAPHEMES = 300;
const MAX_IMAGE_BYTES = 1_000_000;
const VIDEO_SERVICE = "https://video.bsky.app";

interface Session { did: string; accessJwt: string; pds: string }
interface StrongRef { uri: string; cid: string }
type Blob = { $type: "blob"; ref: { $link: string }; mimeType: string; size: number };

function configured(): string | null {
  if (!process.env.BLUESKY_HANDLE || !process.env.BLUESKY_APP_PASSWORD) return "skipped (BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set)";
  if (process.env.BLUESKY_DRY_RUN === "true") return "skipped (BLUESKY_DRY_RUN=true)";
  return null;
}

async function xrpc<T>(base: string, method: string, opts: { jwt?: string; query?: Record<string, string>; json?: unknown; body?: Buffer; contentType?: string; get?: boolean } = {}): Promise<T> {
  const url = new URL(`/xrpc/${method}`, base);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
  else if (opts.body) { headers["Content-Type"] = opts.contentType ?? "application/octet-stream"; body = new Uint8Array(opts.body); }
  const res = await fetch(url, { method: opts.get ? "GET" : "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Bluesky ${method} ${res.status}: ${text.slice(0, 300)}`), { status: res.status, body: text });
  return (text ? JSON.parse(text) : {}) as T;
}

// One session is kept and refreshed instead of logging in on every call
// (Bluesky allows about 300 logins a day; the reply loop alone polls 144 times).
type SessionReply = { did: string; accessJwt: string; refreshJwt: string; didDoc?: { service?: { id: string; serviceEndpoint: string }[] } };
let cached: (Session & { refreshJwt: string; at: number }) | null = null;
const ACCESS_TTL_MS = 60 * 60 * 1000;

function toSession(s: SessionReply, service: string) {
  const pds = s.didDoc?.service?.find((x) => x.id === "#atproto_pds")?.serviceEndpoint ?? service;
  return { did: s.did, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, pds, at: Date.now() };
}

async function login(): Promise<Session> {
  const service = process.env.BLUESKY_SERVICE || "https://bsky.social";
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached;
  if (cached) {
    try {
      cached = toSession(await xrpc<SessionReply>(cached.pds, "com.atproto.server.refreshSession", { jwt: cached.refreshJwt }), service);
      return cached;
    } catch { cached = null; }
  }
  cached = toSession(await xrpc<SessionReply>(service, "com.atproto.server.createSession",
    { json: { identifier: process.env.BLUESKY_HANDLE, password: process.env.BLUESKY_APP_PASSWORD } }), service);
  return cached;
}

function graphemes(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
}

// Splits on sentence ends (then words) into parts of at most 300 characters.
function splitForPosts(text: string): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const parts: string[] = [];
  let current = "";
  const push = () => { if (current.trim()) parts.push(current.trim()); current = ""; };
  for (const s of sentences) {
    if (graphemes(current + s) <= MAX_GRAPHEMES) { current += s; continue; }
    push();
    let rest = s;
    while (graphemes(rest) > MAX_GRAPHEMES) {
      let cut = rest.slice(0, MAX_GRAPHEMES);
      while (graphemes(cut) > MAX_GRAPHEMES) cut = cut.slice(0, -1);
      const sp = cut.lastIndexOf(" ");
      if (sp > 40) cut = cut.slice(0, sp);
      parts.push(cut.trim());
      rest = rest.slice(cut.length);
    }
    current = rest;
  }
  push();
  return parts;
}

async function createPost(s: Session, text: string, extra: { embed?: unknown; reply?: { root: StrongRef; parent: StrongRef } } = {}): Promise<StrongRef> {
  return xrpc<StrongRef>(s.pds, "com.atproto.repo.createRecord", {
    jwt: s.accessJwt,
    json: {
      repo: s.did,
      collection: "app.bsky.feed.post",
      record: { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"], ...extra },
    },
  });
}

// Posts text; the first post may carry an embed, the rest follow as replies.
async function postThread(s: Session, text: string, embed?: unknown): Promise<string> {
  const parts = splitForPosts(text);
  if (parts.length === 0) parts.push("");
  let root: StrongRef | undefined;
  let parent: StrongRef | undefined;
  for (let i = 0; i < parts.length; i++) {
    const ref: StrongRef = await createPost(s, parts[i], { ...(i === 0 && embed ? { embed } : {}), ...(root && parent ? { reply: { root, parent } } : {}) });
    if (!root) root = ref;
    parent = ref;
  }
  return `post ${root!.uri}${parts.length > 1 ? ` (thread of ${parts.length})` : ""}`;
}

async function uploadBlob(s: Session, data: Buffer, mimeType: string): Promise<Blob> {
  const r = await xrpc<{ blob: Blob }>(s.pds, "com.atproto.repo.uploadBlob", { jwt: s.accessJwt, body: data, contentType: mimeType });
  return r.blob;
}

// Bluesky takes images up to 1 MB: re-encode with ffmpeg (already used for the body) if needed.
async function fitImage(image: Buffer): Promise<Buffer> {
  if (image.length <= MAX_IMAGE_BYTES) return image;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = path.join(process.cwd(), "protocols", "tmp");
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(dir, `bsky_in_${Date.now()}.img`);
  const out = path.join(dir, `bsky_out_${Date.now()}.jpg`);
  await fs.writeFile(src, image);
  try {
    for (const [size, q] of [[1000, 3], [900, 5], [800, 7], [640, 9]] as const) {
      await run("ffmpeg", ["-y", "-i", src, "-vf", `scale=${size}:-2`, "-q:v", String(q), out]);
      const buf = await fs.readFile(out);
      if (buf.length <= MAX_IMAGE_BYTES) return buf;
    }
    throw new Error("image still larger than 1 MB after re-encoding");
  } finally {
    await fs.rm(src, { force: true }); await fs.rm(out, { force: true });
  }
}

// Video via Bluesky's video service (processed for playback); direct blob upload as fallback.
async function uploadVideo(s: Session, video: Buffer, filename: string): Promise<Blob> {
  try {
    const aud = `did:web:${new URL(s.pds).hostname}`;
    const exp = String(Math.floor(Date.now() / 1000) + 30 * 60);
    const { token } = await xrpc<{ token: string }>(s.pds, "com.atproto.server.getServiceAuth", {
      jwt: s.accessJwt, get: true, query: { aud, lxm: "com.atproto.repo.uploadBlob", exp },
    });
    let job: { jobId: string; state?: string; blob?: Blob; error?: string };
    try {
      job = await xrpc(VIDEO_SERVICE, "app.bsky.video.uploadVideo", { jwt: token, query: { did: s.did, name: filename }, body: video, contentType: "video/mp4" });
    } catch (err: any) {
      // 409: the same video was uploaded before — the response still carries the job.
      if (err?.status === 409 && err?.body) job = JSON.parse(err.body); else throw err;
    }
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      if (job.blob) return job.blob;
      if (job.state === "JOB_STATE_FAILED") throw new Error(`video processing failed: ${job.error ?? "unknown"}`);
      await new Promise((r) => setTimeout(r, 3000));
      const st = await xrpc<{ jobStatus: typeof job }>(VIDEO_SERVICE, "app.bsky.video.getJobStatus", { get: true, query: { jobId: job.jobId } });
      job = st.jobStatus;
    }
    throw new Error("video processing timed out");
  } catch (err) {
    console.warn("bluesky video service failed, uploading directly:", err instanceof Error ? err.message : String(err));
    return uploadBlob(s, video, "video/mp4");
  }
}

export async function postTextToBluesky(text: string): Promise<string> {
  const skip = configured(); if (skip) return skip;
  const s = await login();
  return postThread(s, text.trim());
}

export async function postVideoToBluesky(video: Buffer, text: string, filename: string, aspect = { width: 16, height: 9 }): Promise<string> {
  const skip = configured(); if (skip) return skip;
  const s = await login();
  const blob = await uploadVideo(s, video, filename);
  return postThread(s, text, { $type: "app.bsky.embed.video", video: blob, aspectRatio: aspect });
}

export async function postImageToBluesky(image: Buffer, text: string, alt: string): Promise<string> {
  const skip = configured(); if (skip) return skip;
  const s = await login();
  const blob = await uploadBlob(s, await fitImage(image), "image/jpeg");
  return postThread(s, text, { $type: "app.bsky.embed.images", images: [{ alt: alt.slice(0, 1000), image: blob, aspectRatio: { width: 1, height: 1 } }] });
}

// Replaces only the profile picture; name, bio and everything else stay as they are.
export async function setBlueskyAvatar(image: Buffer): Promise<string> {
  const skip = configured(); if (skip) return skip;
  const s = await login();
  const blob = await uploadBlob(s, await fitImage(image), "image/jpeg");
  let record: Record<string, unknown> = { $type: "app.bsky.actor.profile" };
  let swapRecord: string | undefined;
  try {
    const cur = await xrpc<{ value: Record<string, unknown>; cid: string }>(s.pds, "com.atproto.repo.getRecord", {
      get: true, query: { repo: s.did, collection: "app.bsky.actor.profile", rkey: "self" },
    });
    record = cur.value; swapRecord = cur.cid;
  } catch { /* no profile record yet */ }
  await xrpc(s.pds, "com.atproto.repo.putRecord", {
    jwt: s.accessJwt,
    json: { repo: s.did, collection: "app.bsky.actor.profile", rkey: "self", record: { ...record, avatar: blob }, ...(swapRecord ? { swapRecord } : {}) },
  });
  return "profile picture updated";
}

// ── for the social loop (bluesky-social.ts) ───────────────────────────────────

export function blueskyReady(): string | null { return configured(); }

export interface BskyNotification {
  uri: string; cid: string; reason: string; indexedAt: string;
  author: { did: string; handle: string; displayName?: string };
  record: { text?: string; reply?: { root: StrongRef; parent: StrongRef } };
}

export async function myDid(): Promise<string> { return (await login()).did; }

export async function listNotifications(limit = 50): Promise<BskyNotification[]> {
  const s = await login();
  const r = await xrpc<{ notifications: BskyNotification[] }>(s.pds, "app.bsky.notification.listNotifications", { jwt: s.accessJwt, get: true, query: { limit: String(limit) } });
  return r.notifications ?? [];
}

export async function markNotificationsSeen(seenAt = new Date().toISOString()): Promise<void> {
  const s = await login();
  await xrpc(s.pds, "app.bsky.notification.updateSeen", { jwt: s.accessJwt, json: { seenAt } });
}

// Replies to one post; only the first 300 characters are used (one post, no thread).
export async function replyOnBluesky(text: string, to: { uri: string; cid: string; root?: StrongRef }): Promise<string> {
  const skip = configured(); if (skip) return skip;
  const s = await login();
  const first = splitForPosts(text.trim())[0] ?? "";
  if (!first) return "nothing to say";
  const parent = { uri: to.uri, cid: to.cid };
  const ref = await createPost(s, first, { reply: { root: to.root ?? parent, parent } });
  return `reply ${ref.uri}`;
}

export async function myRecentPosts(limit = 10): Promise<string[]> {
  const s = await login();
  const r = await xrpc<{ feed: { post: { record: { text?: string } } }[] }>(s.pds, "app.bsky.feed.getAuthorFeed", {
    jwt: s.accessJwt, get: true, query: { actor: s.did, limit: String(limit), filter: "posts_no_replies" },
  });
  return (r.feed ?? []).map((f) => f.post?.record?.text ?? "").filter(Boolean);
}
