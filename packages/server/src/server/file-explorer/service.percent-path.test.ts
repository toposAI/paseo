import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExplorerFile, readExplorerFileBytes } from "./service.js";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("read paths from percent-encoded markdown image links", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paseo-pct-root-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "paseo-pct-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("opens a file whose Japanese directory name arrives percent-encoded", async () => {
    await mkdir(path.join(root, "案C"), { recursive: true });
    await writeFile(path.join(root, "案C", "iphone.png"), PNG);

    const file = await readExplorerFile({ root, relativePath: "%E6%A1%88C/iphone.png" });

    expect(file.kind).toBe("image");
    expect(file.mimeType).toBe("image/png");
  });

  it("opens a file with spaces and parentheses encoded", async () => {
    await writeFile(path.join(root, "my shot (1).png"), PNG);

    const file = await readExplorerFile({ root, relativePath: "my%20shot%20(1).png" });

    expect(file.kind).toBe("image");
  });

  it("prefers the raw path so a real file name containing % still opens", async () => {
    await writeFile(path.join(root, "100%25.png"), PNG);
    await writeFile(path.join(root, "100%.png"), Buffer.concat([PNG, Buffer.from([0])]));

    const file = await readExplorerFileBytes({ root, relativePath: "100%25.png" });

    expect(file.size).toBe(PNG.length);
  });

  it("opens a file literally named with a lone % that is not valid encoding", async () => {
    await writeFile(path.join(root, "50%.png"), PNG);

    const file = await readExplorerFile({ root, relativePath: "50%.png" });

    expect(file.kind).toBe("image");
  });

  it("still reports a missing file as ENOENT", async () => {
    await expect(
      readExplorerFile({ root, relativePath: "%E6%A1%88C/missing.png" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let an encoded traversal escape the workspace", async () => {
    await writeFile(path.join(outside, "secret.png"), PNG);
    const encoded = `%2E%2E/${path.basename(outside)}/secret.png`;

    await expect(readExplorerFile({ root, relativePath: encoded })).rejects.toThrow();
  });

  it("keeps rejecting a raw path outside the workspace", async () => {
    await writeFile(path.join(outside, "secret.png"), PNG);

    await expect(
      readExplorerFile({ root, relativePath: path.join(outside, "secret.png") }),
    ).rejects.toThrow();
  });
});
