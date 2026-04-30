import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalFile, readIndexedFileHash, withIndexMetadata } from "../src/memory/fileIndex.js";

describe("fileIndex", () => {
  it("detects canonical file hash changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rationale-file-index-"));
    const filePath = path.join(directory, "rationales", "R-test.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "first", "utf8");
    const firstFingerprint = await fingerprintCanonicalFile(filePath);

    await writeFile(filePath, "second", "utf8");
    const secondFingerprint = await fingerprintCanonicalFile(filePath);

    expect(firstFingerprint.hash).not.toBe(secondFingerprint.hash);
  });

  it("stores and reads index metadata hash", () => {
    const metadata = withIndexMetadata({}, {
      hash: "abc",
      size: 3,
      modifiedAt: "2026-04-30T00:00:00.000Z"
    });

    expect(readIndexedFileHash(metadata)).toBe("abc");
  });
});
