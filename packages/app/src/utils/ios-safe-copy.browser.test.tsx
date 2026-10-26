import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, Pressable, Text } from "react-native";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyPlainTextWeb } from "./ios-safe-copy";

/**
 * Reproduces the iPhone (insecure http context, no navigator.clipboard) long-press menu: the copy
 * button lives inside a react-native-web Modal, whose focus trap bounces focus out of any field
 * appended to document.body.
 */
let root: Root;
let container: HTMLDivElement;
let result: "pending" | "ok" | "failed" = "pending";
let copied: string | null = null;
let useBodyField = false;

function bodyOnlyCopy(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(field);
  }
}

function handlePress() {
  if (useBodyField) {
    result = bodyOnlyCopy("hello iphone") ? "ok" : "failed";
    return;
  }
  copyPlainTextWeb("hello iphone").then(
    () => (result = "ok"),
    () => (result = "failed"),
  );
}

function Menu() {
  return (
    <Modal visible transparent>
      <Pressable testID="copy-button" onPress={handlePress}>
        <Text>copy</Text>
      </Pressable>
    </Modal>
  );
}

function onCopy(event: ClipboardEvent) {
  copied = document.getSelection()?.toString() ?? null;
  event.preventDefault();
}

beforeEach(() => {
  result = "pending";
  copied = null;
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  document.addEventListener("copy", onCopy);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Menu />));
});

afterEach(() => {
  document.removeEventListener("copy", onCopy);
  act(() => root.unmount());
  container.remove();
});

describe("copy from inside a Modal without navigator.clipboard", () => {
  it("copies the text with the modal-aware field", async () => {
    useBodyField = false;
    await userEvent.click(document.querySelector('[data-testid="copy-button"]') as Element);
    await expect.poll(() => result).not.toBe("pending");
    expect(result).toBe("ok");
    expect(copied).toBe("hello iphone");
  });

  it("(control) a field appended to document.body is bounced by the focus trap", async () => {
    useBodyField = true;
    await userEvent.click(document.querySelector('[data-testid="copy-button"]') as Element);
    await expect.poll(() => result).not.toBe("pending");
    expect(copied).not.toBe("hello iphone");
  });
});
