import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

export type CanonicalFileFingerprint = {
  hash: string;
  size: number;
  modifiedAt: string;
};

export async function fingerprintCanonicalFile(canonicalPath: string): Promise<CanonicalFileFingerprint> {
  const [content, fileStat] = await Promise.all([
    readFile(canonicalPath, "utf8"),
    stat(canonicalPath)
  ]);

  return {
    hash: createHash("sha256").update(content).digest("hex"),
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString()
  };
}

export function readIndexedFileHash(metadata: Record<string, unknown>) {
  const indexMetadata = metadata._index;
  if (!isRecord(indexMetadata)) {
    return undefined;
  }

  return typeof indexMetadata.file_hash === "string" ? indexMetadata.file_hash : undefined;
}

export function withIndexMetadata(
  metadata: Record<string, unknown>,
  fingerprint: CanonicalFileFingerprint
) {
  return {
    ...metadata,
    _index: {
      file_hash: fingerprint.hash,
      file_size: fingerprint.size,
      file_modified_at: fingerprint.modifiedAt,
      indexed_at: new Date().toISOString()
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
