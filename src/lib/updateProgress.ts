export type UpdateProgressPhase = "downloading" | "installing";

export interface UpdateProgressState {
  phase: UpdateProgressPhase;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export function createUpdateProgress(): UpdateProgressState {
  return {
    phase: "downloading",
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
  };
}

export function applyUpdaterDownloadEvent(
  current: UpdateProgressState,
  event: UpdaterDownloadEvent,
): UpdateProgressState {
  if (event.event === "Started") {
    const totalBytes = event.data.contentLength && event.data.contentLength > 0
      ? event.data.contentLength
      : null;
    return {
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes,
      percent: totalBytes === null ? null : 0,
    };
  }

  if (event.event === "Progress") {
    const downloadedBytes = current.downloadedBytes + Math.max(0, event.data.chunkLength);
    const percent = current.totalBytes === null
      ? null
      : Math.min(100, Math.round((downloadedBytes / current.totalBytes) * 100));
    return {
      ...current,
      phase: "downloading",
      downloadedBytes,
      percent,
    };
  }

  return {
    ...current,
    phase: "installing",
    downloadedBytes: current.totalBytes ?? current.downloadedBytes,
    percent: 100,
  };
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function getNumberFormatter(locale: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}:${maximumFractionDigits}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatUpdateBytes(bytes: number, locale: string): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ["KB", "MB", "GB"] as const;
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = value >= 10 ? 1 : 2;
  return `${getNumberFormatter(locale, maximumFractionDigits).format(value)} ${units[unitIndex]}`;
}
