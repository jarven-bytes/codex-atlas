// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Readable, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAppRequestHandler } from "../../src/server/http-handler";

async function invokeRequestHandler(
  handler: ReturnType<typeof createAppRequestHandler>,
  pathname: string
): Promise<{
  status: number;
  headers: Map<string, string>;
  text: string;
}> {
  const request = Object.assign(Readable.from([]), {
    method: "GET",
    url: pathname,
    headers: {}
  });

  const headers = new Map<string, string>();
  let text = "";
  const response = Object.assign(new PassThrough(), {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    }
  });
  response.on("data", (chunk) => {
    text += chunk.toString();
  });

  await handler(request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  if (!response.writableEnded) {
    await finished(response);
  }

  return {
    status: response.statusCode,
    headers,
    text
  };
}

describe("app request handler", () => {
  let tempRoot: string;
  let clientDistDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "http-handler-"));
    clientDistDir = path.join(tempRoot, "dist", "client");
    await mkdir(clientDistDir, { recursive: true });
    await writeFile(path.join(clientDistDir, "index.html"), "<!doctype html><p>client</p>\n");
    await writeFile(path.join(clientDistDir, "app.js"), "console.log('client bundle');\n");
    await writeFile(path.join(tempRoot, "secret.txt"), "SECRET_TOKEN=sk_live_handler_secret\n");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("contains static asset resolution inside the built client directory", async () => {
    const handler = createAppRequestHandler({
      apiHandler: vi.fn().mockResolvedValue(true),
      clientDistDir,
      indexHtmlPath: path.join(clientDistDir, "index.html"),
      logError: vi.fn()
    });

    const validAsset = await invokeRequestHandler(handler, "/app.js");
    expect(validAsset.status).toBe(200);
    expect(validAsset.text).toContain("client bundle");

    const traversalAttempt = await invokeRequestHandler(handler, "/../../secret.txt");
    expect(traversalAttempt.status).toBe(200);
    expect(traversalAttempt.text).toContain("<!doctype html>");
    expect(traversalAttempt.text).not.toContain("sk_live_handler_secret");
  });

  test("redacts unexpected non-api failures", async () => {
    const handler = createAppRequestHandler({
      apiHandler: vi.fn().mockResolvedValue(false),
      clientDistDir: path.join(tempRoot, "missing-dist", "client"),
      indexHtmlPath: path.join(tempRoot, "missing-index.html"),
      logError: vi.fn()
    });

    const response = await invokeRequestHandler(handler, "/");
    expect(response.status).toBe(500);
    expect(response.text).toBe("Internal server error.");
    expect(response.text).not.toContain("missing-index.html");
  });

  test("redacts vite middleware failures before falling through", async () => {
    const handler = createAppRequestHandler({
      apiHandler: vi.fn().mockResolvedValue(false),
      clientDistDir,
      indexHtmlPath: path.join(clientDistDir, "index.html"),
      vite: {
        middlewares(_request, _response, _next) {
          throw new Error("super secret vite stack trace");
        },
        ssrFixStacktrace: vi.fn()
      },
      logError: vi.fn()
    });

    const response = await invokeRequestHandler(handler, "/");
    expect(response.status).toBe(500);
    expect(response.text).toBe("Internal server error.");
    expect(response.text).not.toContain("super secret vite stack trace");
  });
});
