type RequestOptions = {
  method?: string;
  body?: unknown;
};

export async function requestJson(path: string, options: RequestOptions = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(readErrorMessage(data));
  }

  return data;
}

function readErrorMessage(value: unknown) {
  if (isRecord(value)) {
    const errorValue = value.error;
    if (typeof errorValue === "string") {
      return errorValue;
    }
  }

  return "Request failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
