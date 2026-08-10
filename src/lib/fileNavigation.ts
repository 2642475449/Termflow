export interface FileRevealTarget {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  requestId: string;
}

export interface FileNavigationRequest extends FileRevealTarget {
  path: string;
}

export const FILE_NAVIGATION_EVENT = "termflow:file-navigation";

const pendingRequests = new Map<string, FileRevealTarget>();

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function requestFileNavigation(request: FileNavigationRequest): void {
  pendingRequests.set(normalizePath(request.path), request);
  window.dispatchEvent(
    new CustomEvent<FileNavigationRequest>(FILE_NAVIGATION_EVENT, {
      detail: request,
    })
  );
}

export function consumePendingFileNavigation(path: string): FileRevealTarget | null {
  const key = normalizePath(path);
  const request = pendingRequests.get(key) ?? null;
  pendingRequests.delete(key);
  return request;
}

export function isNavigationForPath(requestPath: string, filePath: string): boolean {
  return normalizePath(requestPath) === normalizePath(filePath);
}
