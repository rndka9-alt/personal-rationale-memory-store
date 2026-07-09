import { requestJson } from "./http";
import type { NoteRecord } from "../types/note";
import type { Pagination } from "../types/pagination";

export type NoteSortMode = "newest" | "oldest";

export type NoteFilters = {
  includeArchived: boolean;
  search?: string;
  sortMode: NoteSortMode;
  page: number;
  pageSize: number;
};

export async function fetchNotes(filters: NoteFilters) {
  const params = new URLSearchParams({
    includeArchived: String(filters.includeArchived),
    sortMode: filters.sortMode,
    page: String(filters.page),
    pageSize: String(filters.pageSize)
  });
  if (filters.search) {
    params.set("search", filters.search);
  }
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

function parseNotesResponse(value: unknown): {
  notes: NoteRecord[];
  pagination: Pagination;
} {
  if (!isRecord(value) || !Array.isArray(value.notes) || !isRecord(value.pagination)) {
    throw new Error("Invalid notes response.");
  }

  return {
    notes: value.notes.map(parseNoteRecord),
    pagination: parsePagination(value.pagination)
  };
}

function parsePagination(value: Record<string, unknown>): Pagination {
  return {
    page: readNumber(value, "page"),
    pageSize: readNumber(value, "pageSize"),
    totalItems: readNumber(value, "totalItems"),
    totalPages: readNumber(value, "totalPages")
  };
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
    topic: readOptionalString(value, "topic"),
    sourceConversation: readOptionalSourceConversation(value, "sourceConversation"),
    upvotes: readNumber(value, "upvotes"),
    downvotes: readNumber(value, "downvotes"),
    archived: readBoolean(value, "archived"),
    createdAt: readRequiredString(value, "createdAt"),
    updatedAt: readRequiredString(value, "updatedAt")
  };
}

function readOptionalString(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue === "undefined") {
    return undefined;
  }
  if (typeof propertyValue !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return propertyValue;
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

function readOptionalSourceConversation(value: Record<string, unknown>, key: string): NoteRecord["sourceConversation"] {
  const propertyValue = value[key];
  if (typeof propertyValue === "undefined") {
    return undefined;
  }
  if (!isRecord(propertyValue) || !Array.isArray(propertyValue.messages)) {
    throw new Error(`Expected ${key} to contain messages.`);
  }
  return {
    messages: propertyValue.messages.map(parseSourceConversationMessage)
  };
}

function parseSourceConversationMessage(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid source conversation message.");
  }
  const role = readSourceConversationRole(value, "role");
  const text = readRequiredString(value, "text");
  return { role, text };
}

function readSourceConversationRole(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (propertyValue !== "user" && propertyValue !== "assistant") {
    throw new Error(`Expected ${key} to be a source conversation role.`);
  }
  return propertyValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
