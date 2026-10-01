export interface VoicePolishPreviewChange {
  kind: "unchanged" | "deleted" | "added";
  text: string;
}

/** 固定示例按字符比较并合并连续改动；不调用整理模型。 */
export function diffVoicePolishPreview(source: string, result: string): VoicePolishPreviewChange[] {
  const before = Array.from(source);
  const after = Array.from(result);
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i][j] = before[i] === after[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const changes: VoicePolishPreviewChange[] = [];
  const append = (kind: VoicePolishPreviewChange["kind"], text: string) => {
    const last = changes[changes.length - 1];
    if (last?.kind === kind) last.text += text;
    else changes.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      append("unchanged", before[i++]);
      j++;
    } else if (i < before.length && (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
      append("deleted", before[i++]);
    } else {
      append("added", after[j++]);
    }
  }
  return changes;
}
