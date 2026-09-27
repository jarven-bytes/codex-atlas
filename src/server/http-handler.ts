import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"]
]);

interface ViteMiddleware {
  middlewares(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => Promise<void>
  ): void;
  ssrFixStacktrace?(error: Error): void;
}

export interface CreateAppRequestHandlerOptions {
  apiHandler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  clientDistDir: string;
  indexHtmlPath?: string;
  vite?: ViteMiddleware | null;
  transformIndexHtml?: (url: string, template: string) => Promise<string>;
  logError?: (error: unknown, context: string) => void;
}

function sendHtml(html: string, response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function sendInternalError(response: ServerResponse): void {
  response.statusCode = 500;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end("Internal server error.");
}

function serveStaticFile(filePath: string, response: ServerResponse): void {
  const extension = path.extname(filePath);
  const contentType = contentTypes.get(extension) ?? "application/octet-stream";
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  createReadStream(filePath).pipe(response);
}

function resolveClientAssetPath(clientDistDir: string, requestUrl: string): string | null {
  const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const assetPath = path.resolve(clientDistDir, relativePath);
  const relativeToRoot = path.relative(clientDistDir, assetPath);
  if (
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot) ||
    assetPath === clientDistDir
  ) {
    return null;
  }

  return assetPath;
}

export function createAppRequestHandler(options: CreateAppRequestHandlerOptions) {
  const logError = options.logError ?? ((error: unknown, context: string) => {
    console.error(`[server] ${context}`, error);
  });

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = request.url ?? "/";
    const indexHtmlPath = options.indexHtmlPath ?? path.join(options.clientDistDir, "index.html");

    try {
      if (requestUrl.startsWith("/api/")) {
        await options.apiHandler(request, response);
        return;
      }

      if (options.vite) {
        options.vite.middlewares(request, response, async () => {
          const template = await readFile(indexHtmlPath, "utf8");
          const html = options.transformIndexHtml
            ? await options.transformIndexHtml(requestUrl, template)
            : template;
          sendHtml(html, response);
        });
        return;
      }

      const assetPath = resolveClientAssetPath(options.clientDistDir, requestUrl);
      if (assetPath && existsSync(assetPath) && !assetPath.endsWith(path.sep)) {
        serveStaticFile(assetPath, response);
        return;
      }

      const html = await readFile(indexHtmlPath, "utf8");
      sendHtml(html, response);
    } catch (error) {
      if (options.vite && error instanceof Error) {
        options.vite.ssrFixStacktrace?.(error);
      }
      logError(error, requestUrl);
      sendInternalError(response);
    }
  };
}

export { resolveClientAssetPath };
