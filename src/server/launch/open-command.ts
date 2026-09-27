import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type OpenCommand = (command: string[]) => Promise<void>;

export function createRecordedOpenCommand(logPath: string): OpenCommand {
  return async (command) => {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(command)}\n`, "utf8");
  };
}
