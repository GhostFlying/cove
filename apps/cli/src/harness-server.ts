import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface HarnessServer {
  readonly port: number;
  readonly origin: string;
  // Narrows the page's Content-Security-Policy to the one server endpoint once it is known.
  allowEndpoint(endpoint: string): void;
  close(): Promise<void>;
}

// The CLI depends on @cove/m0-harness as a workspace package, so its installed manifest
// locates the built page; no repository-relative path is assumed.
export async function harnessPageRoot(): Promise<string> {
  const manifest = createRequire(import.meta.url).resolve("@cove/m0-harness/package.json");
  const root = await realpath(join(dirname(manifest), "dist", "page"));
  if (!(await stat(join(root, "index.html")).catch(() => null)))
    throw new Error("@cove/m0-harness is not built (dist/page/index.html is missing)");
  return root;
}

// Serves only the files of the built page, read-only, to loopback clients. It holds no
// credentials: the page receives them in the URL fragment, which browsers never send.
// Requests must name this listener in Host so a rebound DNS name cannot read the page
// through another origin. Directories are never listed, and paths that resolve outside the
// page root (including through symlinks) are refused.
export async function startHarnessServer(root: string, port: number): Promise<HarnessServer> {
  let connectSources = "'none'";
  let origin = "";
  const policy = () =>
    [
      "default-src 'self'",
      `connect-src ${connectSources}`,
      // xterm's DOM renderer writes element styles and a generated stylesheet.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join("; ");
  const server: Server = createServer((request, response) => {
    const refuse = (status: number) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${status}\n`);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      refuse(405);
      return;
    }
    if (request.headers.host !== new URL(origin).host) {
      refuse(421);
      return;
    }
    void resolveFile(root, request.url ?? "/").then(
      (file) => {
        if (!file) {
          refuse(404);
          return;
        }
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(file.path)] ?? "application/octet-stream",
          "content-length": file.size,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cross-origin-resource-policy": "same-origin",
          ...(file.path.endsWith(".html") ? { "content-security-policy": policy() } : {}),
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const stream = createReadStream(file.path);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      },
      () => refuse(500),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The page server has no TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    origin,
    allowEndpoint(endpoint: string) {
      const url = new URL(endpoint);
      const socket = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
      connectSources = `${url.origin} ${socket}`;
    },
    close() {
      closing ??= new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

async function resolveFile(
  root: string,
  rawUrl: string,
): Promise<{ path: string; size: number } | undefined> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0") || pathname.split("/").includes("..")) return undefined;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  let path: string;
  try {
    path = await realpath(join(root, relative));
  } catch {
    return undefined;
  }
  if (!path.startsWith(`${root}${sep}`)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return { path, size: info.size };
}
