export interface TerminalImageAttachment {
  id: string;
  src: string;
  alt: string;
  insertedText: string;
}

export type ImagePreviewReader = (path: string) => Promise<{ dataUrl: string }>;

export interface ResolvedDroppedImageAttachments {
  accepted: TerminalImageAttachment[];
  failedCount: number;
}

export function quotePathForShell(path: string): string {
  const escaped = path.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export async function resolveDroppedImageAttachments(
  paths: string[],
  readPreview: ImagePreviewReader
): Promise<ResolvedDroppedImageAttachments> {
  const uniquePaths: string[] = [];
  for (const path of paths) {
    if (!uniquePaths.includes(path)) {
      uniquePaths.push(path);
    }
  }

  const results = await Promise.allSettled(
    uniquePaths.map(async (path) => {
      const preview = await readPreview(path);
      const segments = path.split(/[\\/]/);
      const attachment: TerminalImageAttachment = {
        id: path,
        src: preview.dataUrl,
        alt: segments[segments.length - 1] || path,
        insertedText: quotePathForShell(path),
      };
      return attachment;
    })
  );

  const accepted: TerminalImageAttachment[] = [];
  let failedCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      accepted.push(result.value);
    } else {
      failedCount += 1;
    }
  }

  return { accepted, failedCount };
}
