"use client";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
  }
}

async function handle(response: Response) {
  if (response.ok) {
    const type = response.headers.get("content-type") ?? "";
    return type.includes("application/json") ? response.json() : response.text();
  }
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    /* non-JSON error */
  }
  throw new ApiError(
    response.status,
    body.code ?? "error",
    body.message ?? `Request failed (${response.status})`,
    body.requestId
  );
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  return handle(response);
}

export async function apiSend<T = any>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-omni-csrf": "1",
    },
    body: JSON.stringify(body ?? {}),
  });
  return handle(response);
}

export const apiPost = <T = any>(path: string, body?: unknown) => apiSend<T>("POST", path, body);
export const apiPatch = <T = any>(path: string, body?: unknown) => apiSend<T>("PATCH", path, body);
export const apiDelete = <T = any>(path: string) => apiSend<T>("DELETE", path);

export function downloadExport(projectId: string, format: string, citationStyle?: string) {
  return fetch(`/api/projects/${projectId}/export`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-omni-csrf": "1" },
    body: JSON.stringify({ format, citationStyle }),
  }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, "export-failed", "Export failed");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `export-${format}.txt`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}
