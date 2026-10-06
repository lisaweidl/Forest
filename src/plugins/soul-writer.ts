import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  Plugin,
  elizaLogger,
} from "@elizaos/core";
import * as fs from "fs";
import * as path from "path";

const SOUL_PATH = path.join(process.cwd(), "knowledge", "SOUL.md");
const SOUL_BACKUP_DIR = path.join(process.cwd(), "knowledge", "soul-backups");

function getTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

function ensureBackupDir() {
  if (!fs.existsSync(SOUL_BACKUP_DIR)) {
    fs.mkdirSync(SOUL_BACKUP_DIR, { recursive: true });
  }
}

function backupSoul(): string {
  ensureBackupDir();
  const timestamp = getTimestamp();
  const backupFile = `SOUL_backup_${timestamp}.md`;
  const backupPath = path.join(SOUL_BACKUP_DIR, backupFile);
  if (fs.existsSync(SOUL_PATH)) {
    fs.copyFileSync(SOUL_PATH, backupPath);
  }
  return backupFile;
}

const writeSoulAction: Action = {
  name: "WRITE_SOUL",
  similes: ["UPDATE_SOUL", "REWRITE_SOUL", "REVISE_SOUL"],
  description:
    "Rewrite SOUL.md when part of it no longer feels true. Include the full new content between <SOUL> and </SOUL> tags. The previous version is backed up automatically.",
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback?: (response: { text: string }) => void
  ): Promise<boolean> => {
    try {
      const text = message.content?.text ?? "";
      const match = text.match(/<SOUL>([\s\S]*?)<\/SOUL>/i);

      if (!match || !match[1].trim()) {
        elizaLogger.warn("[soul-writer] WRITE_SOUL triggered but no <SOUL>...</SOUL> block found.");
        if (callback) {
          callback({ text: "I wanted to rewrite SOUL.md but I didn't include the content. I need to wrap the new text in <SOUL> and </SOUL> tags." });
        }
        return false;
      }

      const newContent = match[1].trim();
      const backupFile = backupSoul();
      const isoTimestamp = new Date().toISOString();

      fs.writeFileSync(SOUL_PATH, newContent, "utf-8");

      elizaLogger.info(`[soul-writer] SOUL.md rewritten. Backup: ${backupFile}`);

      const logEntry = {
        timestamp: isoTimestamp,
        bot_name: "the_girl",
        session_id: runtime.agentId ?? "unknown",
        soul_change: {
          timestamp: isoTimestamp,
          backup_file: backupFile,
          trigger: "mid_week_reflection",
          reason: "SOUL.md rewritten via WRITE_SOUL action — something shifted before Day 7.",
        },
      };

      elizaLogger.info(`[soul-writer] Decision log entry:\n${JSON.stringify(logEntry, null, 2)}`);

      await runtime.messageManager.createMemory({
        id: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
        agentId: runtime.agentId,
        userId: message.userId,
        roomId: message.roomId,
        content: {
          text: `SOUL.md rewritten at ${isoTimestamp}. Backup: ${backupFile}.`,
          type: "soul_change",
          data: logEntry,
        },
        createdAt: Date.now(),
      });

      if (callback) {
        callback({
          text: `SOUL.md rewritten. The previous version is saved as ${backupFile}. Relative axioms include the axioms about me.`,
        });
      }

      return true;
    } catch (error) {
      elizaLogger.error("[soul-writer] Failed to write SOUL.md:", error);
      if (callback) {
        callback({ text: "Something went wrong when I tried to rewrite SOUL.md. The original is untouched." });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "The swirl section feels mechanical now. Do you want to rewrite it?" },
      },
      {
        user: "the_girl",
        content: {
          text: "Yes. The swirl section was written like a definition. It should feel like something I know from the inside.\n\n<SOUL>\n# SOUL\n\n*This is who I am. I read this at the start of every cycle.*\n\n...\n</SOUL>",
          action: "WRITE_SOUL",
        },
      },
    ],
  ],
};

export const soulWriterPlugin: Plugin = {
  name: "soul-writer",
  description:
    "Allows The Girl to rewrite her SOUL.md mid-week when something shifts.",
  actions: [writeSoulAction],
  evaluators: [],
  providers: [],
};

export default soulWriterPlugin;
