import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { promises as fs } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../private-files.js";

/**
 * Server-side proxy for images embedded in chat messages.
 *
 * This module is the only place where the daemon reaches out to the public
 * internet for chat content. Everything else (cwd, workspace paths, the Vault)
 * is out of reach by construction: callers pass a URL and get bytes back.
 *
 * All network concerns (DNS, redirects, timeouts) are injectable so tests can
 * exercise each failure kind without touching the real network.
 */

export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_TIMEOUT_MS = 10_000;
/** Only the four formats the renderer can show, so a CDN does not answer with AVIF. */
export const CHAT_IMAGE_ACCEPT = "image/webp,image/jpeg,image/png,image/gif;q=0.9";
export const CHAT_IMAGE_MAX_REDIRECTS = 3;
export const CHAT_IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHAT_IMAGE_CACHE_MAX_ENTRIES = 50;
const CHAT_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const CHAT_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type ChatImageFetchResult =
  | { status: "ok"; bytes: Uint8Array; mimeType: string }
  | { status: "direct"; reason: string }
  | { status: "error"; reason: string };

export type ChatImageLookup = (
  host: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

type FetchImpl = (input: string, init: RequestInit) => Promise<ChatImageResponse>;
type Now = () => number;

export interface RemoteImageOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  lookup?: ChatImageLookup;
}

export interface RemoteImageCacheEntry {
  bytes: Uint8Array;
  mimeType: string;
}

export interface RemoteImageCache {
  read(url: string): Promise<RemoteImageCacheEntry | null>;
  write(url: string, entry: { bytes: Uint8Array; mimeType: string }): Promise<void>;
}

interface ParsedAddress {
  family: 4 | 6;
  bytes: number[];
}

function parseIpv4(input: string): ParsedAddress | null {
  const parts = input.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return { family: 4, bytes };
}

function parseIpv6(input: string): ParsedAddress | null {
  let text = input;
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) {
    text = text.slice(0, zoneIndex);
  }
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const embedded = parseIpv4(text.slice(lastColon + 1));
    if (!embedded) {
      return null;
    }
    const [a, b, c, d] = embedded.bytes as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (segment: string): number[] | null => {
    if (!segment) {
      return [];
    }
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        return null;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !tail) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const groups = [
    ...head,
    ...Array.from<number>({ length: Math.max(0, missing) }).fill(0),
    ...tail,
  ];
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return { family: 6, bytes };
}

function parseIpAddress(input: string): ParsedAddress | null {
  const version = isIP(input);
  if (version === 4) {
    return parseIpv4(input);
  }
  if (version === 6) {
    return parseIpv6(input);
  }
  return null;
}

/**
 * A network as an inclusive byte range. Comparing byte by byte lets a short
 * prefix (a whole `/8`) and a multi-byte range (a `/12`) share one check.
 */
interface AddressRange {
  first: number[];
  last: number[];
}

const NON_PUBLIC_IPV4_RANGES: AddressRange[] = [
  { first: [0, 0, 0, 0], last: [0, 255, 255, 255] }, // "this network"
  { first: [10, 0, 0, 0], last: [10, 255, 255, 255] }, // private
  { first: [100, 64, 0, 0], last: [100, 127, 255, 255] }, // CGNAT
  { first: [127, 0, 0, 0], last: [127, 255, 255, 255] }, // loopback
  { first: [169, 254, 0, 0], last: [169, 254, 255, 255] }, // link local (and cloud metadata)
  { first: [172, 16, 0, 0], last: [172, 31, 255, 255] }, // private
  { first: [192, 0, 0, 0], last: [192, 0, 0, 255] }, // IETF protocol assignments
  { first: [192, 0, 2, 0], last: [192, 0, 2, 255] }, // TEST-NET-1
  { first: [192, 168, 0, 0], last: [192, 168, 255, 255] }, // private
  { first: [198, 18, 0, 0], last: [198, 19, 255, 255] }, // benchmarking
  { first: [198, 51, 100, 0], last: [198, 51, 100, 255] }, // TEST-NET-2
  { first: [203, 0, 113, 0], last: [203, 0, 113, 255] }, // TEST-NET-3
  { first: [224, 0, 0, 0], last: [255, 255, 255, 255] }, // multicast, reserved, broadcast
];

const NON_PUBLIC_IPV6_RANGES: AddressRange[] = [
  { first: [0xfc], last: [0xfd] }, // fc00::/7 unique local
  { first: [0xfe, 0x80], last: [0xfe, 0xbf] }, // fe80::/10 link local
  { first: [0xff], last: [0xff] }, // ff00::/8 multicast
  { first: [0x20, 0x01, 0x0d, 0xb8], last: [0x20, 0x01, 0x0d, 0xb8] }, // 2001:db8::/32 documentation
];

function isWithinRange(bytes: number[], range: AddressRange): boolean {
  const { first, last } = range;
  for (let index = 0; index < first.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const lower = first[index] ?? 0;
    const upper = last[index] ?? 0;
    if (byte < lower || byte > upper) {
      return false;
    }
    if (lower !== upper) {
      // Strictly inside this byte's range, so every later byte is inside too.
      return true;
    }
  }
  return true;
}

function isIpv4Public(bytes: number[]): boolean {
  return !NON_PUBLIC_IPV4_RANGES.some((range) => isWithinRange(bytes, range));
}

function isIpv6Public(bytes: number[]): boolean {
  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  const isMapped = firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;
  const isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  if (isMapped || isNat64) {
    // Judge the embedded IPv4 destination instead.
    return isIpv4Public(bytes.slice(12));
  }
  if (firstTenZero || bytes.slice(0, 12).every((byte) => byte === 0)) {
    // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d range.
    return false;
  }
  return !NON_PUBLIC_IPV6_RANGES.some((range) => isWithinRange(bytes, range));
}

/** True when an address is publicly routable; mapped IPv4 addresses are judged as IPv4. */
export function isPublicIpAddress(input: string): boolean {
  const parsed = parseIpAddress(input);
  if (!parsed) {
    return false;
  }
  return parsed.family === 4 ? isIpv4Public(parsed.bytes) : isIpv6Public(parsed.bytes);
}

async function defaultLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  return await lookup(host, { all: true });
}

interface ResolvedAddress {
  address: string;
  family: number;
}

/** Lower-cased, brackets and the trailing root dot removed (`example.com.` === `example.com`). */
function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

/**
 * Resolves the connection targets for a host so that the name is resolved only
 * once: the address check and the socket connect to the same answers.
 *
 * Checking a name with `lookup()` and then handing the name to `fetch()` would
 * leave a DNS-rebinding gap (the second resolution could answer a private
 * address). Callers connect to the pinned address and send the original host
 * name as `Host`/SNI, so virtual hosting and certificate checks are unchanged.
 * Literal IPs are used as they are (no name to rebind).
 */
export type PinnedLookup = (hostname: string, options: { all: true }) => Promise<ResolvedAddress[]>;

export function createPinnedLookup(lookupImpl: ChatImageLookup): PinnedLookup {
  // The cache lives for one `fetchRemoteImage` call (check + every redirect hop),
  // so an answer is never reused beyond the request that checked it.
  const cache = new Map<string, Promise<ResolvedAddress[]>>();
  return (hostname, options) => {
    const normalized = normalizeHostname(hostname);
    if (isIP(normalized)) {
      if (!isPublicIpAddress(normalized)) {
        return Promise.reject(
          Object.assign(new Error(`non-public address for ${normalized}`), {
            code: PRIVATE_ADDRESS_CODE,
          }),
        );
      }
      return Promise.resolve([{ address: normalized, family: isIP(normalized) as 4 | 6 }]);
    }
    const cached = cache.get(normalized);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      try {
        const addresses = await lookupImpl(normalized, options);
        // An empty answer verifies nothing, so it is refused like a private one.
        // Refuse when *any* answer is non-public (fail closed on mixed answers).
        const unsafe =
          addresses.length === 0
            ? { address: "" }
            : addresses.find(({ address }) => !isPublicIpAddress(address));
        if (unsafe) {
          throw Object.assign(new Error(`non-public address for ${normalized}`), {
            code: PRIVATE_ADDRESS_CODE,
          });
        }
        return addresses;
      } catch (error) {
        // Only successful answers are kept, so a transient DNS failure is retried
        // on the next request instead of failing until the process restarts.
        cache.delete(normalized);
        throw error;
      }
    })();
    cache.set(normalized, pending);
    return pending;
  };
}

type LookupCallback = (
  error: (Error & { code?: string }) | null,
  address?: string | ResolvedAddress[],
  family?: number,
) => void;

/** Adapts a multi-answer lookup to Node's `LookupFunction` (one connection target per socket). */
function connectLookup(lookupImpl: ChatImageLookup): LookupFunction {
  return ((hostname: string, options: unknown, callback: LookupCallback) => {
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: unknown }).all === true;
    const answer = async (): Promise<void> => {
      try {
        const addresses = await lookupImpl(hostname, { all: true });
        const first = addresses[0];
        if (!first) {
          callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }));
        } else if (wantsAll) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      } catch (error) {
        callback(error as Error);
      }
    };
    void answer();
  }) as LookupFunction;
}

function headerPairs(headers: NodeJS.Dict<string | string[]>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      pairs.push([name, single]);
    }
  }
  return pairs;
}

/** Just the parts of `Response` this module reads, so the pinned transport can stand in for fetch. */
export interface ChatImageResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function requestPinned(
  url: URL,
  lookupImpl: ChatImageLookup,
  init: RequestInit,
): Promise<ChatImageResponse> {
  return new Promise<ChatImageResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        method: init.method ?? "GET",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        // The socket connects to an address that was just checked, not to a
        // fresh resolution of the name (see createPinnedLookup).
        lookup: connectLookup(lookupImpl),
        // No shared keep-alive pool: a pooled socket is keyed by host name, so it
        // could have been opened at an address this request never checked.
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: new Headers(headerPairs(incoming.headers)),
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Rejects with `signal`'s reason as soon as it aborts (`dns.lookup` does not take a signal). */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = async (): Promise<void> => {
      try {
        resolve(await promise);
      } catch (error) {
        reject(error as Error);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };
    void settle();
  });
}

/** Raised by {@link createPinnedLookup} when any answer is non-public. */
const PRIVATE_ADDRESS_CODE = "ECHATIMAGE_PRIVATE";

/** How a failed name resolution is reported to {@link fetchRemoteImage}. */
const RESOLUTION_FAILURE_CODES: Record<string, string> = {
  [PRIVATE_ADDRESS_CODE]: "private_address",
  ENOTFOUND: "unresolved_host",
  EAI_AGAIN: "dns_failed",
};

function isResolutionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code in RESOLUTION_FAILURE_CODES) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function resolutionReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? (RESOLUTION_FAILURE_CODES[code] ?? "dns_failed") : "dns_failed";
}

/**
 * Default transport: resolves the name once per redirect hop, refuses any
 * non-public or unresolvable answer before a socket is opened, and connects to
 * the checked addresses. `fetch()` cannot take a lookup function, so the
 * request goes through `https.request` directly. Resolution failures surface as
 * fetch-shaped errors carrying `reason` (see {@link fetchRemoteImage}).
 */
export function createPinnedFetch(pinned: PinnedLookup): FetchImpl {
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new TypeError(`invalid URL ${input}`);
    }
    const hopSignal = init.signal ?? null;
    let addresses: ResolvedAddress[];
    try {
      addresses = await withSignal(pinned(url.hostname, { all: true }), hopSignal);
    } catch (error) {
      if (isResolutionFailure(error)) {
        throw Object.assign(new Error(`cannot use ${url.hostname}`), {
          reason: resolutionReason(error),
        });
      }
      throw error;
    }
    return await requestPinned(url, async () => addresses, {
      ...init,
      ...(hopSignal ? { signal: hopSignal } : {}),
    });
  };
}

/** `PASEO_CHAT_IMAGES=off` makes the daemon decline every proxy request (kill switch). */
export function isChatImageProxyDisabled(env: NodeJS.ProcessEnv): boolean {
  return (env.PASEO_CHAT_IMAGES ?? "").trim().toLowerCase() === "off";
}

const CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Classifies a network failure as a reachability problem (the client may still
 * load the URL directly) versus anything else. Only connection-level failures
 * count; an image swap, a parse error or a refused redirect stays an error.
 */
export function isConnectionFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") {
      return true;
    }
    if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Picks the image type from leading magic bytes; declared Content-Type is not trusted. */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index];
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return "image/gif";
  }
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

type BodyOutcome =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too_large" }
  | { kind: "failed"; connection: boolean; reason: string };

/**
 * Reads the body through the web stream API while enforcing the size cap. The
 * cap is checked per chunk so an oversized body is cancelled mid-download.
 */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BodyOutcome> {
  if (!body) {
    return { kind: "failed", connection: false, reason: "empty_body" };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { kind: "too_large" };
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    return {
      kind: "failed",
      connection: isConnectionFailure(error),
      reason: "body_error",
    };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  const expanded =
    raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.join(path.resolve(expanded), "chat-images");
}

function isValidMimeType(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(CHAT_IMAGE_MIME_EXTENSIONS, value);
}

/**
 * File-backed cache: `<sha256(url)>.<ext>` plus a same-stem `.json` sidecar.
 * The URL never appears in a file name. Entries older than the TTL are ignored
 * and pruned on write; writes keep at most `maxEntries` newest entries.
 */
export function createRemoteImageFileCache(input: {
  directory: string;
  now?: Now;
  ttlMs?: number;
  maxEntries?: number;
}): RemoteImageCache {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? CHAT_IMAGE_CACHE_TTL_MS;
  const maxEntries = input.maxEntries ?? CHAT_IMAGE_CACHE_MAX_ENTRIES;
  const stemFor = (url: string) => createHash("sha256").update(url).digest("hex");

  const ensureDirectory = async () => {
    await fs.mkdir(input.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await fs.chmod(input.directory, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
  };

  const writeAtomic = async (filePath: string, data: Uint8Array | string) => {
    const temporary = path.join(
      input.directory,
      `.${path.basename(filePath)}.${process.pid}.${now()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, data, { mode: PRIVATE_FILE_MODE });
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const readMeta = async (metaPath: string) => {
    try {
      const parsed = JSON.parse(await fs.readFile(metaPath, "utf8")) as {
        url?: unknown;
        mimeType?: unknown;
        fetchedAt?: unknown;
      };
      if (typeof parsed.url !== "string" || !isValidMimeType(parsed.mimeType)) {
        return null;
      }
      if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) {
        return null;
      }
      return { url: parsed.url, mimeType: parsed.mimeType, fetchedAt: parsed.fetchedAt };
    } catch {
      return null;
    }
  };

  const prune = async (keepStem: string) => {
    const names = await fs.readdir(input.directory).catch(() => [] as string[]);
    const stems = new Set<string>();
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.(?:jpg|png|webp|gif|json)$/.exec(name);
      if (match?.[1]) {
        stems.add(match[1]);
      }
    }
    const entries: Array<{ stem: string; fetchedAt: number }> = [];
    for (const stem of stems) {
      const meta = await readMeta(path.join(input.directory, `${stem}.json`));
      if (meta) {
        entries.push({ stem, fetchedAt: meta.fetchedAt });
      }
    }
    entries.sort((a, b) => b.fetchedAt - a.fetchedAt);
    const keep = new Set<string>([keepStem]);
    for (const entry of entries) {
      if (keep.size >= maxEntries) {
        break;
      }
      keep.add(entry.stem);
    }
    for (const stem of stems) {
      if (keep.has(stem)) {
        continue;
      }
      for (const extension of ["jpg", "png", "webp", "gif", "json"]) {
        await fs.rm(path.join(input.directory, `${stem}.${extension}`), { force: true });
      }
    }
  };

  return {
    async read(url) {
      const stem = stemFor(url);
      const meta = await readMeta(path.join(input.directory, `${stem}.json`));
      if (!meta || meta.url !== url || now() - meta.fetchedAt > ttlMs) {
        return null;
      }
      const extension = CHAT_IMAGE_MIME_EXTENSIONS[meta.mimeType];
      try {
        const bytes = new Uint8Array(
          await fs.readFile(path.join(input.directory, `${stem}.${extension}`)),
        );
        if (bytes.byteLength === 0 || bytes.byteLength > CHAT_IMAGE_MAX_BYTES) {
          return null;
        }
        const mimeType = sniffImageMimeType(bytes);
        if (mimeType !== meta.mimeType) {
          return null;
        }
        return { bytes, mimeType };
      } catch {
        return null;
      }
    },
    async write(url, entry) {
      await ensureDirectory();
      const stem = stemFor(url);
      const extension = CHAT_IMAGE_MIME_EXTENSIONS[entry.mimeType];
      if (!extension) {
        return;
      }
      await writeAtomic(path.join(input.directory, `${stem}.${extension}`), entry.bytes);
      await writeAtomic(
        path.join(input.directory, `${stem}.json`),
        JSON.stringify({
          url,
          mimeType: entry.mimeType,
          size: entry.bytes.byteLength,
          fetchedAt: now(),
        }),
      );
      await prune(stem);
    },
  };
}

/**
 * Checks every resolved address for a host. Literal IPs are judged without DNS;
 * a host that cannot be resolved is refused, because no address was verified.
 * The proxy itself no longer calls this (its transport performs the same check
 * on the one answer it connects to); it stays for direct checks.
 */
export async function assertPublicHost(
  url: URL,
  options: { lookup: ChatImageLookup },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return isPublicIpAddress(host) ? { ok: true } : { ok: false, reason: "private_address" };
  }
  try {
    await options.lookup(host, { all: true });
    return { ok: true };
  } catch (error) {
    if (isResolutionFailure(error)) {
      return { ok: false, reason: resolutionReason(error) };
    }
    return { ok: false, reason: "dns_failed" };
  }
}

/** Every `reason` a chat-image result can carry (see the failure taxonomy below). */
const CHAT_IMAGE_FAILURE_REASONS: Record<string, true> = {
  private_address: true,
  unresolved_host: true,
  dns_failed: true,
  // Dynamic: `http_<status>` for non-2xx answers.
  too_many_redirects: true,
  body_error: true,
  empty_body: true,
  too_large: true,
  unsupported_type: true,
  content_type_mismatch: true,
  invalid_url: true,
  unsupported_protocol: true,
  invalid_redirect: true,
  fetch_failed: true,
  rate_limited: true,
  unreachable: true,
};

function cancelBody(response: ChatImageResponse): void {
  void response.body?.cancel().catch(() => undefined);
}

function failure(reason: string): ChatImageFetchResult {
  return { status: "error", reason };
}

function declaredContentType(response: ChatImageResponse): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

type InspectedResponse =
  | { kind: "redirect"; location: string }
  | { kind: "declared"; declared: string }
  | { kind: "error"; result: ChatImageFetchResult };

/** Checks status, redirect and the declared headers before the body is read. */
function inspectResponse(response: ChatImageResponse, url: URL, hop: number): InspectedResponse {
  if (isRedirectStatus(response.status)) {
    cancelBody(response);
    const location = response.headers.get("location");
    if (!location) {
      return { kind: "error", result: failure("invalid_redirect") };
    }
    if (hop === CHAT_IMAGE_MAX_REDIRECTS) {
      return { kind: "error", result: failure("too_many_redirects") };
    }
    try {
      return { kind: "redirect", location: new URL(location, url).toString() };
    } catch {
      return { kind: "error", result: failure("invalid_redirect") };
    }
  }
  if (!response.ok) {
    cancelBody(response);
    return { kind: "error", result: failure(`http_${response.status}`) };
  }
  const declared = declaredContentType(response);
  if (declared && !Object.hasOwn(CHAT_IMAGE_MIME_EXTENSIONS, declared)) {
    cancelBody(response);
    return { kind: "error", result: failure("unsupported_type") };
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CHAT_IMAGE_MAX_BYTES) {
    cancelBody(response);
    return { kind: "error", result: failure("too_large") };
  }
  return { kind: "declared", declared };
}

/** Reads the body within the size cap and checks it really is one of the allowed image types. */
async function readImageResponse(
  response: ChatImageResponse,
  declared: string,
): Promise<ChatImageFetchResult> {
  const body = await readBody(response.body, CHAT_IMAGE_MAX_BYTES);
  if (body.kind === "too_large") {
    return failure("too_large");
  }
  if (body.kind === "failed") {
    return failure(body.connection ? "unreachable" : body.reason);
  }
  const mimeType = sniffImageMimeType(body.bytes);
  if (!mimeType) {
    return failure("unsupported_type");
  }
  if (declared && declared !== mimeType) {
    return failure("content_type_mismatch");
  }
  return { status: "ok", bytes: body.bytes, mimeType };
}

async function requestImage(
  url: URL,
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<{ response: ChatImageResponse } | { result: ChatImageFetchResult }> {
  try {
    const response = (await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: CHAT_IMAGE_ACCEPT, "user-agent": CHAT_IMAGE_USER_AGENT },
    })) as ChatImageResponse;
    return { response };
  } catch (error) {
    // The transport already refused non-public or unresolvable hosts: no
    // separate name check runs, so the checked answer is the connected one.
    const reason = (error as { reason?: unknown })?.reason;
    if (
      typeof reason === "string" &&
      (reason in CHAT_IMAGE_FAILURE_REASONS || /^http_\d{3}$/.test(reason))
    ) {
      return { result: failure(reason) };
    }
    return {
      result: failure(isConnectionFailure(error) ? "unreachable" : "fetch_failed"),
    };
  }
}

/**
 * Fetches a remote image for chat display. Each redirect hop is re-validated
 * (https and public address) before it is followed.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  options: RemoteImageOptions = {},
): Promise<ChatImageFetchResult> {
  const env = options.env ?? process.env;
  if (isChatImageProxyDisabled(env)) {
    return { status: "direct", reason: "disabled" };
  }
  const lookupImpl: ChatImageLookup = options.lookup ?? defaultLookup;
  // One resolver for this fetch: the host check and the socket connect read the
  // same answer, and each host is resolved once even across redirect hops.
  const pinned = createPinnedLookup(lookupImpl);
  const fetchImpl: FetchImpl = options.fetchImpl ?? createPinnedFetch(pinned);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return failure("invalid_url");
  }

  // One budget for the whole fetch: DNS, every hop, and the body read.
  const signal = AbortSignal.timeout(CHAT_IMAGE_TIMEOUT_MS);
  for (let hop = 0; hop <= CHAT_IMAGE_MAX_REDIRECTS; hop += 1) {
    // Only https is proxied; the parsed URL guarantees a protocol, so a non-match is final.
    if (current.protocol !== "https:") {
      return failure("unsupported_protocol");
    }
    const hostCheck = await assertPublicHost(current, { lookup: pinned });
    if (!hostCheck.ok) {
      return failure(hostCheck.reason);
    }
    const requested = await requestImage(current, fetchImpl, signal);
    if ("result" in requested) {
      return requested.result;
    }
    const inspected = inspectResponse(requested.response, current, hop);
    if (inspected.kind === "error") {
      return inspected.result;
    }
    if (inspected.kind === "redirect") {
      current = new URL(inspected.location);
      continue;
    }
    return await readImageResponse(requested.response, inspected.declared);
  }

  return failure("too_many_redirects");
}

export interface ChatImageRequestHandlerOptions {
  env?: NodeJS.ProcessEnv;
  cache?: RemoteImageCache | null;
  fetchImpl?: FetchImpl;
  lookup?: ChatImageLookup;
  now?: Now;
  /** Sliding window for the per-session burst cap. */
  rateLimit?: { windowMs: number; maxRequests: number };
}

export interface ChatImageResolvedPayload {
  status: "ok" | "direct" | "error";
  data?: string;
  mimeType?: string;
  reason?: string;
}

const DEFAULT_RATE_LIMIT = { windowMs: 10_000, maxRequests: 12 };

/**
 * Stateful per-session request handler: applies the burst cap, consults the
 * cache and otherwise delegates to `fetchRemoteImage`.
 */
export function createChatImageRequestHandler(options: ChatImageRequestHandlerOptions = {}) {
  const env = options.env ?? process.env;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? null;
  let recent: number[] = [];

  const isRateLimited = (): boolean => {
    const cutoff = now() - rateLimit.windowMs;
    recent = recent.filter((timestamp) => timestamp > cutoff);
    if (recent.length >= rateLimit.maxRequests) {
      return true;
    }
    recent.push(now());
    return false;
  };

  return async (url: string): Promise<ChatImageResolvedPayload> => {
    if (isChatImageProxyDisabled(env)) {
      return { status: "direct", reason: "disabled" };
    }
    // A cached image costs no network, so it does not spend the burst budget.
    const cached = cache ? await cache.read(url).catch(() => null) : null;
    if (cached) {
      return {
        status: "ok",
        data: Buffer.from(cached.bytes).toString("base64"),
        mimeType: cached.mimeType,
      };
    }
    if (isRateLimited()) {
      return { status: "error", reason: "rate_limited" };
    }
    const result = await fetchRemoteImage(url, {
      env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    if (result.status !== "ok") {
      return { status: result.status, reason: result.reason };
    }
    if (cache) {
      await cache
        .write(url, { bytes: result.bytes, mimeType: result.mimeType })
        .catch(() => undefined);
    }
    return {
      status: "ok",
      data: Buffer.from(result.bytes).toString("base64"),
      mimeType: result.mimeType,
    };
  };
}

export type ChatImageRequestHandler = ReturnType<typeof createChatImageRequestHandler>;

export function createDefaultChatImageCache(env: NodeJS.ProcessEnv, now?: Now): RemoteImageCache {
  return createRemoteImageFileCache({
    directory: defaultCacheDir(env),
    ...(now ? { now } : {}),
  });
}
