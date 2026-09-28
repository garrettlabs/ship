import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.ts";
import { gitDirtySnapshot } from "./project-profile.ts";
import type { GitSnapshot } from "./handoff.ts";

/** Capture index and working-tree content for every dirty path; refuse incomplete status. */
export async function captureHandoffGit(root: string): Promise<GitSnapshot> {
  const status = await gitDirtySnapshot(root);
  if (status.unknown || status.truncated || !status.branch) throw new Error("Cannot capture an incomplete Git status or unknown branch");
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  const dirty: Record<string, string> = Object.create(null);
  for (const filename of [...status.paths].sort()) {
    const hash = createHash("sha256");
    const full = path.join(root, filename);
    const stat = await lstat(full).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) hash.update("absent\0");
    else if (stat.isFile()) {
      hash.update("file\0");
      for await (const part of createReadStream(full)) hash.update(part);
    } else if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(full));
    } else throw new Error(`Unsupported dirty path for handoff: ${filename}`);
    hash.update("\0index\0").update(await git(root, ["ls-files", "--stage", "--", filename]));
    dirty[filename] = hash.digest("hex");
  }
  const after = await gitDirtySnapshot(root);
  if (after.unknown || after.truncated || after.branch !== status.branch ||
      JSON.stringify([...after.paths].sort()) !== JSON.stringify([...status.paths].sort()) ||
      await git(root, ["rev-parse", "--verify", "HEAD"]) !== head)
    throw new Error("Git status changed during handoff snapshot; retry at a settled boundary");
  return { branch: status.branch, head, dirty };
}
