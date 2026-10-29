import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_IMAGE_MAX_BYTES,
  assertPublicHost,
  createChatImageRequestHandler,
  createRemoteImageFileCache,
  fetchRemoteImage,
  isConnectionFailure,
  isPublicIpAddress,
  sniffImageMimeType,
  type ChatImageLookup,
} from "./remote-image.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);

const PUBLIC_LOOKUP: ChatImageLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function imageResponse(bytes: Uint8Array, init: ResponseInit = {}) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png" },
    ...init,
  });
}

function redirectResponse(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function connectionError(code: string, cause?: unknown) {
  return Object.assign(new TypeError("fetch failed"), { cause: cause ?? { code } });
}

const tempDirs: string[] = [];
async function makeTempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-images-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("fetchRemoteImage", () => {
  it("returns bytes and sniffs the MIME type on success", async () => {
    const fetchImpl = vi.fn(async () => imageResponse(PNG_BYTES));
    const result = await fetchRemoteImage("https://example.com/a.png", {
      env: {},
      fetchImpl,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "ok", bytes: PNG_BYTES, mimeType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).accept).toBe("image/*");
  });

  it.each([
    ["http://example.com/a.png", "unsupported_protocol"],
    ["file:///etc/passwd", "unsupported_protocol"],
    ["ftp://example.com/a.png", "unsupported_protocol"],
    ["not a url", "invalid_url"],
  ])("rejects non-https sources (%s)", async (url, reason) => {
    const fetchImpl = vi.fn();
    const result = await fetchRemoteImage(url, {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "error", reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "[::1]",
    "[fe80::1]",
    "[fc00::1]",
    "[::ffff:192.168.0.1]",
    "[::ffff:7f00:1]",
  ])("rejects private or loopback literal address %s", async (host) => {
    const fetchImpl = vi.fn();
    const result = await fetchRemoteImage(`https://${host}/a.png`, {
      env: {},
      fetchImpl: fetchImpl as never,
    });
    expect(result).toEqual({ status: "error", reason: "private_address" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["93.184.216.34", true],
    ["172.32.0.1", true],
    ["2606:4700::1111", true],
    ["::ffff:93.184.216.34", true],
    ["64:ff9b::808:808", true],
    ["::ffff:10.0.0.1", false],
    ["::ffff:a00:1", false],
    ["[::ffff:127.0.0.1]", false],
    ["250.1.2.3", false],
    ["198.18.0.1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["febf::1", false],
    ["2001:db8::1", false],
    ["192.0.2.1", false],
    ["203.0.113.9", false],
    ["192.0.1.1", true],
    ["172.32.0.1", true],
    ["::", false],
    ["ff02::1", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["bogus", false],
  ])("classifies address %s as public=%s", (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });

  it("rejects a hostname when any resolved address is private", async () => {
    const fetchImpl = vi.fn();
    const lookup: ChatImageLookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ];
    const result = await fetchRemoteImage("https://example.com/a.png", {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup,
    });
    expect(result).toEqual({ status: "error", reason: "private_address" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates each redirect hop and resolves relative locations", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      seen.push(input);
      if (input === "https://example.com/a.png") {
        return redirectResponse("/b.png", 301);
      }
      return imageResponse(JPEG_BYTES, { headers: { "content-type": "image/jpeg" } });
    });
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const result = await fetchRemoteImage("https://example.com/a.png", {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup,
    });
    expect(result.status).toBe("ok");
    expect(seen).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to http", async () => {
    const fetchImpl = vi.fn(async () => redirectResponse("http://example.com/b.png", 307));
    const result = await fetchRemoteImage("https://example.com/a.png", {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "error", reason: "unsupported_protocol" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a private address", async () => {
    const fetchImpl = vi.fn(async () => redirectResponse("https://127.0.0.1/a.png", 302));
    const result = await fetchRemoteImage("https://example.com/a.png", {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "error", reason: "private_address" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows up to three redirects and rejects the fourth", async () => {
    const threeHops = vi.fn(async (input: string) =>
      input.endsWith("/4.png")
        ? imageResponse(PNG_BYTES)
        : redirectResponse(`${Number(input.match(/(\d)\.png/)?.[1]) + 1}.png`),
    );
    const ok = await fetchRemoteImage("https://example.com/1.png", {
      env: {},
      fetchImpl: threeHops as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(ok.status).toBe("ok");
    expect(threeHops).toHaveBeenCalledTimes(4);

    const fourHops = vi.fn(async (input: string) =>
      redirectResponse(`${Number(input.match(/(\d)\.png/)?.[1]) + 1}.png`),
    );
    const result = await fetchRemoteImage("https://example.com/1.png", {
      env: {},
      fetchImpl: fourHops as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "error", reason: "too_many_redirects" });
    expect(fourHops).toHaveBeenCalledTimes(4);
  });

  it("stops at 5MB while streaming the body", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const result = await fetchRemoteImage("https://example.com/big.png", {
      env: {},
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(result).toEqual({ status: "error", reason: "too_large" });
    expect(cancelled).toBe(true);

    const declaredLarge = vi.fn(
      async () =>
        new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(CHAT_IMAGE_MAX_BYTES + 1),
          },
        }),
    );
    expect(
      await fetchRemoteImage("https://example.com/big.png", {
        env: {},
        fetchImpl: declaredLarge as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "too_large" });
  });

  it("rejects a body whose magic bytes are not an allowed image", async () => {
    const html = new TextEncoder().encode("<html>not an image</html>");
    const fetchImpl = vi.fn(
      async () => new Response(html, { status: 200, headers: { "content-type": "image/png" } }),
    );
    expect(
      await fetchRemoteImage("https://example.com/fake.png", {
        env: {},
        fetchImpl: fetchImpl as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "unsupported_type" });
  });

  it("rejects a declared type that disagrees with the bytes and non-image content types", async () => {
    const mismatch = vi.fn(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    expect(
      await fetchRemoteImage("https://example.com/x", {
        env: {},
        fetchImpl: mismatch as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "content_type_mismatch" });

    const text = vi.fn(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(
      await fetchRemoteImage("https://example.com/x", {
        env: {},
        fetchImpl: text as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "unsupported_type" });
  });

  it("accepts a body with no declared content type when the bytes match", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(WEBP_BYTES, { status: 200 })));
    expect(
      await fetchRemoteImage("https://example.com/x.webp", {
        env: {},
        fetchImpl: fetchImpl as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toMatchObject({ status: "ok", mimeType: "image/webp" });
    expect(sniffImageMimeType(GIF_BYTES)).toBe("image/gif");
  });

  it.each([
    ["timeout", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["abort", () => Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["ENOTFOUND", () => connectionError("ENOTFOUND")],
    ["EAI_AGAIN", () => connectionError("EAI_AGAIN")],
    ["ECONNREFUSED", () => connectionError("ECONNREFUSED")],
    ["ETIMEDOUT", () => connectionError("ETIMEDOUT", { code: "ETIMEDOUT" })],
  ])("falls back to direct on a connection-level failure (%s)", async (_label, makeError) => {
    const fetchImpl = vi.fn(async () => {
      throw makeError();
    });
    expect(
      await fetchRemoteImage("https://example.com/a.png", {
        env: {},
        fetchImpl: fetchImpl as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "direct", reason: "unreachable" });
  });

  it("reports non-connection failures and HTTP errors as errors", async () => {
    const broken = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(
      await fetchRemoteImage("https://example.com/a.png", {
        env: {},
        fetchImpl: broken as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "fetch_failed" });

    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    expect(
      await fetchRemoteImage("https://example.com/a.png", {
        env: {},
        fetchImpl: notFound as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "error", reason: "http_404" });
    expect(isConnectionFailure(new Error("other"))).toBe(false);
  });

  it("falls back to direct when PASEO_CHAT_IMAGES=off", async () => {
    const fetchImpl = vi.fn();
    expect(
      await fetchRemoteImage("https://example.com/a.png", {
        env: { PASEO_CHAT_IMAGES: "off" },
        fetchImpl: fetchImpl as never,
        lookup: PUBLIC_LOOKUP,
      }),
    ).toEqual({ status: "direct", reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an unresolvable host as an error", async () => {
    const failing: ChatImageLookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    const url = new URL("https://unknown.invalid/a.png");
    expect(await assertPublicHost(url, { lookup: failing })).toEqual({
      ok: false,
      reason: "unresolved_host",
    });
    expect(await assertPublicHost(url, { lookup: async () => [] })).toEqual({
      ok: false,
      reason: "unresolved_host",
    });
  });
});

describe("createRemoteImageFileCache", () => {
  it("stores bytes and metadata under a sha256 file name with private permissions", async () => {
    const directory = path.join(await makeTempDir(), "chat-images");
    const cache = createRemoteImageFileCache({ directory, now: () => 1_000 });
    await cache.write("https://example.com/a.png", { bytes: PNG_BYTES, mimeType: "image/png" });

    const names = (await readdir(directory)).sort();
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(/^[0-9a-f]{64}\.(png|json)$/);
      expect(name).not.toContain("example");
    }
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of names) {
        expect((await stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
      }
    }
    const jsonName = names.find((name) => name.endsWith(".json"));
    const meta = JSON.parse(await readFile(path.join(directory, jsonName ?? ""), "utf8"));
    expect(meta).toMatchObject({
      url: "https://example.com/a.png",
      mimeType: "image/png",
      size: PNG_BYTES.byteLength,
      fetchedAt: 1_000,
    });
    expect(await cache.read("https://example.com/a.png")).toEqual({
      bytes: PNG_BYTES,
      mimeType: "image/png",
    });
  });

  it("expires entries after 30 days", async () => {
    let now = 1_000;
    const cache = createRemoteImageFileCache({ directory: await makeTempDir(), now: () => now });
    await cache.write("https://example.com/a.png", { bytes: PNG_BYTES, mimeType: "image/png" });
    const day = 24 * 60 * 60 * 1000;
    now += 29 * day;
    expect(await cache.read("https://example.com/a.png")).not.toBeNull();
    now += 2 * day;
    expect(await cache.read("https://example.com/a.png")).toBeNull();
  });

  it("ignores entries whose bytes no longer match the metadata", async () => {
    const directory = await makeTempDir();
    let now = 1_000;
    const cache = createRemoteImageFileCache({ directory, now: () => now });
    await cache.write("https://example.com/a.png", { bytes: PNG_BYTES, mimeType: "image/png" });
    const pngName = (await readdir(directory)).find((name) => name.endsWith(".png"));
    await writeFile(path.join(directory, pngName ?? ""), JPEG_BYTES);
    expect(await cache.read("https://example.com/a.png")).toBeNull();
  });

  it("prunes to the 50 newest entries on write", async () => {
    const directory = await makeTempDir();
    let now = 1_000;
    const cache = createRemoteImageFileCache({ directory, now: () => now });
    for (let index = 0; index < 55; index += 1) {
      now += 1;
      await cache.write(`https://example.com/${index}.png`, {
        bytes: PNG_BYTES,
        mimeType: "image/png",
      });
    }
    const jsonFiles = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(jsonFiles).toHaveLength(50);
    expect(await cache.read("https://example.com/0.png")).toBeNull();
    expect(await cache.read("https://example.com/54.png")).not.toBeNull();
  });
});

describe("createChatImageRequestHandler", () => {
  it("serves a cache hit without fetching again", async () => {
    const directory = await makeTempDir();
    let now = 1_000;
    const cache = createRemoteImageFileCache({ directory, now: () => now });
    const fetchImpl = vi.fn(async () => imageResponse(PNG_BYTES));
    const handler = createChatImageRequestHandler({
      env: {},
      cache,
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
      now: () => now,
    });

    const first = await handler("https://example.com/a.png");
    expect(first).toEqual({
      status: "ok",
      data: Buffer.from(PNG_BYTES).toString("base64"),
      mimeType: "image/png",
    });
    now += 1_000;
    const second = await handler("https://example.com/a.png");
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("limits bursts to 12 requests per 10 seconds", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => imageResponse(PNG_BYTES));
    const handler = createChatImageRequestHandler({
      env: {},
      cache: null,
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
      now: () => now,
    });
    for (let index = 0; index < 12; index += 1) {
      now += 1;
      expect((await handler(`https://example.com/${index}.png`)).status).toBe("ok");
    }
    expect(await handler("https://example.com/overflow.png")).toEqual({
      status: "error",
      reason: "rate_limited",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    now += 10_000;
    expect((await handler("https://example.com/after.png")).status).toBe("ok");
  });

  it("returns direct without fetching when disabled", async () => {
    const fetchImpl = vi.fn();
    const handler = createChatImageRequestHandler({
      env: { PASEO_CHAT_IMAGES: "off" },
      cache: null,
      fetchImpl: fetchImpl as never,
      lookup: PUBLIC_LOOKUP,
    });
    expect(await handler("https://example.com/a.png")).toEqual({
      status: "direct",
      reason: "disabled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
