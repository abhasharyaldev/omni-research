import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Detection of locally installed Claude skills (Markdown instruction packs).
 *
 * A Claude Code skill is a directory containing SKILL.md with YAML
 * frontmatter (name, description) followed by the skill's instructions.
 * Claude Code consumes a skill by loading SKILL.md into the model's context;
 * this integration does exactly the same: it reads the installed skill file
 * verbatim at invocation time and passes its instructions to the provider.
 * Nothing is hard-coded — if the user edits or removes the skill, detection
 * and the recorded content hash change accordingly.
 */

export type DetectedSkill = {
  id: string;
  name: string;
  description: string;
  /** Full instruction body (frontmatter stripped). */
  instructions: string;
  filePath: string;
  /** sha256 of the file — recorded per invocation as the "skill version". */
  contentHash: string;
  source: "project" | "user";
};

export type SkillDetectionReport = {
  storytelling: DetectedSkill | null;
  viralHooks: DetectedSkill | null;
  searchedPaths: string[];
  detectedAt: string;
};

function skillRoots(projectRoot: string): { dir: string; source: "project" | "user" }[] {
  return [
    { dir: path.join(projectRoot, ".claude", "skills"), source: "project" },
    { dir: path.join(os.homedir(), ".claude", "skills"), source: "user" },
  ];
}

function parseSkillFile(filePath: string, source: "project" | "user"): DetectedSkill | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;
    const frontmatter = match[1]!;
    const body = match[2]!.trim();
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    if (!name || !body) return null;
    return {
      id: name,
      name,
      description,
      instructions: body,
      filePath,
      contentHash: createHash("sha256").update(raw).digest("hex"),
      source,
    };
  } catch {
    return null;
  }
}

/** Find one skill by directory name. Project-level skills win over user-level. */
export function detectSkill(skillId: string, projectRoot = process.cwd()): DetectedSkill | null {
  for (const { dir, source } of skillRoots(projectRoot)) {
    const filePath = path.join(dir, skillId, "SKILL.md");
    if (existsSync(filePath)) {
      const parsed = parseSkillFile(filePath, source);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Detect the storytelling skill and its documented companion (the
 * storytelling skill explicitly hands hook-writing off to `viral-hooks`).
 */
export function detectStorytellingSkills(projectRoot = process.cwd()): SkillDetectionReport {
  return {
    storytelling: detectSkill("storytelling", projectRoot),
    viralHooks: detectSkill("viral-hooks", projectRoot),
    searchedPaths: skillRoots(projectRoot).map((r) => r.dir),
    detectedAt: new Date().toISOString(),
  };
}
