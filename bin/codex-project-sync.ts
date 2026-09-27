#!/usr/bin/env node

import { serverConfig } from "../src/server/config";
import type { CodexActivityEvent } from "../src/shared/domain";

interface ParsedArgs {
  taskId?: string;
  workingDirectory?: string;
  summary?: string;
  changedPaths: string[];
  milestone?: string;
  decisionOrBlocker?: "decision" | "blocker";
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    changedPaths: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case "--task-id":
        parsed.taskId = value;
        index += 1;
        break;
      case "--working-directory":
        parsed.workingDirectory = value;
        index += 1;
        break;
      case "--summary":
        parsed.summary = value;
        index += 1;
        break;
      case "--changed-path":
        if (value) {
          parsed.changedPaths.push(value);
        }
        index += 1;
        break;
      case "--milestone":
        parsed.milestone = value;
        index += 1;
        break;
      case "--decision":
        parsed.decisionOrBlocker = "decision";
        break;
      case "--blocker":
        parsed.decisionOrBlocker = "blocker";
        break;
      default:
        break;
    }
  }

  return parsed;
}

function assertRequired(value: string | undefined, flagName: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing required flag: ${flagName}`);
  }

  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const event: CodexActivityEvent = {
    taskId: assertRequired(args.taskId, "--task-id"),
    workingDirectory: assertRequired(args.workingDirectory, "--working-directory"),
    summary: assertRequired(args.summary, "--summary"),
    changedPaths: args.changedPaths,
    milestone: args.milestone,
    decisionOrBlocker: args.decisionOrBlocker,
    sourceId: `codex:${assertRequired(args.taskId, "--task-id")}`
  };

  const response = await fetch(`${serverConfig.syncServerUrl}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    throw new Error(`Sync failed with ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
