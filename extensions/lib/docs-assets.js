import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Very small YAML-ish parser for vendor-pins files used by Reversa Docs.
 * Supports the subset we need: lib blocks with files.url/local/fallbacks.
 *
 * @param {string} raw
 * @returns {{ libs: Array<{ name: string, files: Array<{ url: string, local: string, fallbacks: string[] }> }> }}
 */
export function parseVendorPins(raw) {
  /** @type {Array<{ name: string, files: Array<{ url: string, local: string, fallbacks: string[] }> }>} */
  const libs = [];
  /** @type {{ name: string, files: Array<{ url: string, local: string, fallbacks: string[] }> } | null} */
  let currentLib = null;
  /** @type {{ url: string, local: string, fallbacks: string[] } | null} */
  let currentFile = null;
  let inLibs = false;
  let inFiles = false;
  let inFallbacks = false;

  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^libs:\s*$/.test(line)) {
      inLibs = true;
      continue;
    }
    if (!inLibs) continue;

    const libMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (libMatch) {
      currentLib = { name: libMatch[1], files: [] };
      libs.push(currentLib);
      currentFile = null;
      inFiles = false;
      inFallbacks = false;
      continue;
    }

    if (/^ {4}files:\s*$/.test(line)) {
      inFiles = true;
      inFallbacks = false;
      continue;
    }
    if (!currentLib || !inFiles) continue;

    const urlMatch = line.match(/^ {6}-\s*url:\s*["']?([^"']+)["']?\s*$/);
    if (urlMatch) {
      currentFile = { url: urlMatch[1], local: "", fallbacks: [] };
      currentLib.files.push(currentFile);
      inFallbacks = false;
      continue;
    }
    if (!currentFile) continue;

    const localMatch = line.match(/^ {8}local:\s*["']?([^"']+)["']?\s*$/);
    if (localMatch) {
      currentFile.local = localMatch[1];
      continue;
    }
    if (/^ {8}fallbacks:\s*$/.test(line)) {
      inFallbacks = true;
      continue;
    }
    if (inFallbacks) {
      const fb = line.match(/^ {10}-\s*["']?([^"']+)["']?\s*$/);
      if (fb) currentFile.fallbacks.push(fb[1]);
    }
  }

  return { libs: libs.filter((lib) => lib.files.every((file) => file.url && file.local)) };
}

/**
 * @param {string} url
 * @param {string} destination
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 */
async function downloadHttps(url, destination, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing non-HTTPS vendor URL: ${url}`);
  }

  await new Promise((resolvePromise, reject) => {
    const req = httpsRequest(url, { method: "GET", timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== "https:") {
          reject(new Error(`refusing non-HTTPS redirect: ${next.href}`));
          return;
        }
        downloadHttps(next.href, destination, options).then(resolvePromise, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      mkdirSync(dirname(destination), { recursive: true });
      const tmp = `${destination}.${process.pid}.tmp`;
      const file = createWriteStream(tmp);
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.destroy(new Error(`download exceeded ${maxBytes} bytes`));
        }
      });
      pipeline(res, file)
        .then(() => {
          renameSync(tmp, destination);
          resolvePromise(undefined);
        })
        .catch((error) => {
          try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
          reject(error);
        });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout downloading ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Download vendor assets declared by vendor-pins into docs folder.
 *
 * @param {object} options
 * @param {string} options.docsRoot absolute docs folder
 * @param {string} options.pinsPath absolute vendor-pins.yaml path
 * @returns {Promise<{ downloaded: string[], missing: string[], usedFallback: Array<{ local: string, url: string }> }>}
 */
export async function ensureDocsVendors(options) {
  const raw = readFileSync(options.pinsPath, "utf8");
  const { libs } = parseVendorPins(raw);
  /** @type {string[]} */
  const downloaded = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {Array<{ local: string, url: string }>} */
  const usedFallback = [];

  for (const lib of libs) {
    for (const file of lib.files) {
      const destination = join(options.docsRoot, file.local);
      if (existsSync(destination) && statSync(destination).size > 0) {
        downloaded.push(file.local);
        continue;
      }
      const candidates = [file.url, ...file.fallbacks];
      let ok = false;
      for (const [index, candidate] of candidates.entries()) {
        try {
          await downloadHttps(candidate, destination);
          downloaded.push(file.local);
          if (index > 0) usedFallback.push({ local: file.local, url: candidate });
          ok = true;
          break;
        } catch {
          // try next
        }
      }
      if (!ok) missing.push(file.local);
    }
  }

  return { downloaded, missing, usedFallback };
}

/**
 * Static + lightweight HTTP smoke validation for generated docs pages.
 *
 * @param {object} options
 * @param {string} options.docsRoot
 * @returns {Promise<{ ok: boolean, errors: Array<{ page: string, kind: string, detail: string }>, checked: number }>}
 */
export async function smokeTestDocs(options) {
  const docsRoot = resolve(options.docsRoot);
  /** @type {Array<{ page: string, kind: string, detail: string }>} */
  const errors = [];
  const pages = listHtmlFiles(docsRoot);
  let checked = 0;

  // Static checks first.
  for (const page of pages) {
    checked += 1;
    const absolute = join(docsRoot, page);
    const html = readFileSync(absolute, "utf8");
    if (/https?:\/\/cdn\.|unpkg\.com|jsdelivr\.net|code\.highcharts\.com/i.test(html)) {
      errors.push({ page, kind: "cdn", detail: "page references external CDN" });
    }
    if (/fetch\s*\(\s*["']assets\//i.test(html)) {
      errors.push({ page, kind: "fetch-local", detail: "page uses fetch() for local assets" });
    }
    for (const match of html.matchAll(/src=["']([^"']+)["']/g)) {
      const src = match[1];
      if (/^https?:\/\//i.test(src) || src.startsWith("data:")) continue;
      const assetPath = resolve(dirname(absolute), src);
      if (!assetPath.startsWith(docsRoot)) {
        errors.push({ page, kind: "asset-escape", detail: src });
        continue;
      }
      if (!existsSync(assetPath)) {
        errors.push({ page, kind: "asset-missing", detail: src });
      }
    }
  }

  // Local loopback GET of each page.
  if (pages.length > 0) {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const relative = urlPath === "/" ? "/index.html" : urlPath;
        const filePath = resolve(docsRoot, `.${relative}`);
        if (!filePath.startsWith(docsRoot) || !existsSync(filePath)) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        res.writeHead(200, { "content-type": contentTypeFor(filePath) });
        res.end(readFileSync(filePath));
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      for (const page of pages) {
        const response = await fetch(`http://127.0.0.1:${port}/${page}`);
        if (!response.ok) {
          errors.push({ page, kind: "http-status", detail: `status ${response.status}` });
          continue;
        }
        const body = await response.text();
        if (/Failed to fetch|Access to fetch|NetworkError|Erro ao carregar/i.test(body)) {
          errors.push({ page, kind: "error-pattern", detail: "error pattern in body" });
        }
      }
    } finally {
      await new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)));
    }
  }

  return { ok: errors.length === 0, errors, checked };
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listHtmlFiles(root) {
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} dir
   * @param {string} prefix
   */
  function walk(dir, prefix) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "assets") continue;
        walk(absolute, rel);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        out.push(rel.replaceAll("\\", "/"));
      }
    }
  }
  walk(root, "");
  return out.sort();
}

/**
 * @param {string} filePath
 */
function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/**
 * Stable short hash for logs.
 *
 * @param {string} value
 */
export function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
