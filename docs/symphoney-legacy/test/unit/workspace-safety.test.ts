import { describe, it, expect } from "vitest";
import {
  isInsideRoot,
  sanitizeWorkspaceKey,
  workspacePathFor,
} from "../../src/workspace/safety.js";

describe("sanitizeWorkspaceKey", () => {
  it("preserves [A-Za-z0-9._-] characters", () => {
    expect(sanitizeWorkspaceKey("MT-123_v.1")).toBe("MT-123_v.1");
  });
  it("replaces other characters with _", () => {
    expect(sanitizeWorkspaceKey("MT 123/foo:bar")).toBe("MT_123_foo_bar");
  });
  it("returns _ for empty", () => {
    expect(sanitizeWorkspaceKey("")).toBe("_");
  });
});

describe("isInsideRoot", () => {
  it("requires path to be a child of root, not equal", () => {
    expect(isInsideRoot("/a", "/a")).toBe(false);
    expect(isInsideRoot("/a", "/a/b")).toBe(true);
  });
  it("rejects sibling paths", () => {
    expect(isInsideRoot("/a", "/abc")).toBe(false);
    expect(isInsideRoot("/a/b", "/a/bc")).toBe(false);
  });
  it("rejects out-of-root absolute paths", () => {
    expect(isInsideRoot("/a", "/etc/passwd")).toBe(false);
  });
  it("normalizes and accepts traversal that resolves inside root", () => {
    expect(isInsideRoot("/a", "/a/b/../c")).toBe(true);
  });
  it("rejects traversal that escapes root", () => {
    expect(isInsideRoot("/a", "/a/../etc")).toBe(false);
  });
});

describe("workspacePathFor", () => {
  it("joins sanitized key under root", () => {
    expect(workspacePathFor("/tmp/ws", "MT-1")).toBe("/tmp/ws/MT-1");
    expect(workspacePathFor("/tmp/ws", "weird/name with space")).toBe(
      "/tmp/ws/weird_name_with_space",
    );
  });
});
