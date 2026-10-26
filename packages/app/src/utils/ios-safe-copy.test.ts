import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPlainTextWeb, resolveCopyContainer } from "./ios-safe-copy";

interface FakeNode {
  children: FakeNode[];
  parentElement: FakeNode | null;
  [key: string]: unknown;
}

function node(parent: FakeNode | null = null): FakeNode {
  const created: FakeNode = {
    children: [],
    parentElement: parent,
    style: {},
    tagName: "DIV",
    appendChild(child: FakeNode) {
      child.parentElement = created;
      created.children.push(child);
    },
    removeChild(child: FakeNode) {
      created.children = created.children.filter((c) => c !== child);
      child.parentElement = null;
    },
  };
  parent?.children.push(created);
  return created;
}

function stubDocument(activeElement: FakeNode, body: FakeNode, documentElement: FakeNode) {
  const doc = {
    body,
    documentElement,
    activeElement,
    createElement: () => {
      const field = node();
      field.focus = () => {};
      field.select = () => {};
      field.setSelectionRange = () => {};
      return field;
    },
    execCommand: (cmd: string) => {
      expect(cmd).toBe("copy");
      return true;
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", {});
  return doc;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCopyContainer", () => {
  it("uses the focused element itself so the field stays inside a modal focus trap", () => {
    const html = node();
    const body = node(html);
    const modal = node(body);
    const pressed = node(modal);
    stubDocument(pressed, body, html);
    expect(resolveCopyContainer()).toBe(pressed);
  });

  it("uses the parent when the focused element cannot hold children", () => {
    const html = node();
    const body = node(html);
    const modal = node(body);
    const button = node(modal);
    button.tagName = "BUTTON";
    stubDocument(button, body, html);
    expect(resolveCopyContainer()).toBe(modal);
  });

  it("falls back to body when nothing useful is focused", () => {
    const html = node();
    const body = node(html);
    stubDocument(body, body, html);
    expect(resolveCopyContainer()).toBe(body);
  });
});

describe("copyPlainTextWeb", () => {
  it("appends the temporary field inside the focused element's container and removes it", async () => {
    const html = node();
    const body = node(html);
    const modal = node(body);
    const button = node(modal);
    const doc = stubDocument(button, body, html);
    const appended: FakeNode[] = [];
    const original = button.appendChild as (child: FakeNode) => void;
    button.tagName = "BUTTON";
    modal.appendChild = (child: FakeNode) => {
      appended.push(child);
      original.call(modal, child);
    };
    await copyPlainTextWeb("hello");
    expect(appended).toHaveLength(1);
    expect(body.children).not.toContain(appended[0]);
    expect(modal.children).not.toContain(appended[0]);
    expect(doc.activeElement).toBe(button);
  });

  it("rejects when execCommand reports failure", async () => {
    const html = node();
    const body = node(html);
    const doc = stubDocument(body, body, html);
    doc.execCommand = () => false;
    await expect(copyPlainTextWeb("x")).rejects.toThrow("Clipboard copy failed");
  });
});
