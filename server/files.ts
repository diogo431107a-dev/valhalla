// Reading and writing the data folder.
//
// Everything Valhalla keeps is a plain file you can open in an editor: one JSON file per
// character and persona, and one append-only JSONL log per conversation. Three things make that
// safe to do from a running server, and they all live here:
//
//   - a write lands whole or not at all (write a .tmp file, then rename over the target),
//   - two writes to one path never interleave (each path has a queue),
//   - a log cut short by a crash loses only the unfinished line.
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StoreError } from "./errors.ts";

/** Where everything is kept. Relative to wherever the server was started. */
export const DATA_DIR = process.env.VALHALLA_DATA ?? "data";

export const pathOf = (...parts: string[]): string => join(DATA_DIR, ...parts);

// One queue per path. Writes to the same file run one after another, so a read never catches a
// half-written file and two requests never race.
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // Run after whatever is queued, whether that succeeded or failed.
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  // Let the map forget a path once nothing is waiting on it.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/** Writes `value` as formatted JSON, leaving either the old file or the new one, never a mix. */
export function writeJson(file: string, value: unknown): Promise<void> {
  return serialize(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    // rename() replaces the target in one step, on Windows as well as elsewhere.
    await rename(temporary, file);
  });
}

/** The parsed contents of a JSON file, or null when there is no such file. */
export async function readJson(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StoreError(500, `${file} is not valid JSON. Fix or move the file, then try again.`);
  }
}

/** Adds one line to a log. The line is complete before anything else may write to the file. */
export function appendLine(file: string, value: unknown): Promise<void> {
  return serialize(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
  });
}

/**
 * Every line of a log, oldest first. A final line with no newline was cut short by a crash
 * mid-write: it is dropped, and said so once. A broken line anywhere else is not something to
 * quietly skip — it would silently change a conversation — so it stops the read.
 */
export async function readLines(file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  if (text === "") return [];
  const lines = text.split("\n");
  // A finished file ends in a newline, so the last piece is empty. Anything else is a cut-off
  // line: a write that never got to finish.
  const tail = lines.pop();
  if (tail !== "") {
    console.log(`${file}: the last line was never finished, so it was left out. Nothing else changed.`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new StoreError(500, `${file}, line ${index + 1} is not valid JSON. Fix the file, then try again.`);
    }
  });
}

/** The names of the .json files in a folder, without the extension. Missing folder means none. */
export async function listIds(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

/** The names of the subfolders of a folder. Missing folder means none. */
export async function listFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

/** Deletes a file or a folder and everything in it. Doing it twice is not an error. */
export function remove(target: string): Promise<void> {
  return serialize(target, () => rm(target, { recursive: true, force: true }));
}
