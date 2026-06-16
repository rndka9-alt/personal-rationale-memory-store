import { requestJson } from "./http";
import type { NoteRecord } from "../types/note";

export async function fetchNotes(includeArchived: boolean) {
  const params = new URLSearchParams({
    includeArchived: String(includeArchived)
  });
  const data = await requestJson(`/api/notes?${params.toString()}`);
  return parseNotesResponse(data);
}

export async function archiveNote(id: string) {
  const data = await requestJson(`/api/notes/${encodeURIComponent(id)}/archive`, {
    method: "POST"
  });
  return parseNoteActionResponse(data);
}

export async function restoreNote(id: string) {
  const data = await requestJson(`/api/notes/${encodeURIComponent(id)}/restore`, {
    method: "POST"
  });
  return parseNoteActionResponse(data);
}

function parseNotesResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.notes)) {
    throw new Error("Invalid notes response.");
  }

  return value.notes.map(parseNoteRecord);
}

function parseNoteActionResponse(value: unknown) {
  if (!isRecord(value) || !isRecord(value.note)) {
    throw new Error("Invalid note action response.");
  }

  return parseNoteRecord(value.note);
}

function parseNoteRecord(value: unknown): NoteRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid note record.");
  }

  return {
    id: readRequiredString(value, "id"),
    content: readRequiredString(value, "content"),
    upvotes: readNumber(value, "upvotes"),
    downvotes: readNumber(value, "downvotes"),
    archived: readBoolean(value, "archived"),
    createdAt: readRequiredString(value, "createdAt"),
    updatedAt: readRequiredString(value, "updatedAt")
  };
}

function readRequiredString(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return propertyValue;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "number") {
    throw new Error(`Expected ${key} to be a number.`);
  }
  return propertyValue;
}

function readBoolean(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "boolean") {
    throw new Error(`Expected ${key} to be a boolean.`);
  }
  return propertyValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
