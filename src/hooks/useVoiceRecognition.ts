import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import { type MimoAuthMode } from "@/lib/mimoAsr";
import {
  getAsrTransport,
  normalizeAsrError,
  type AsrError,
} from "@/lib/asrRuntime";
import {
  buildDashScopeAsrRequest,
  buildOpenAICompatibleAsrRequest,
  extractDashScopeAsrText,
  extractDashScopeApiErrorMessage,
  getDashScopeEndpoint,
  getOpenAICompatibleEndpoint,
  type DashScopeAsrModel,
  type DashScopeRegion,
} from "@/lib/dashscopeAsr";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const LEVEL_POLL_INTERVAL_MS = 200;
const MAX_AUTO_DURATION_MS = 60_000;
const MIMO_ASR_UPLOAD_MIME_TYPE = "audio/wav";
const SUCCESS_SETTLE_MS = 2_000;
const ERROR_SETTLE_MS = 2_600;

// ASR 幻觉词列表：静音/噪音时模型容易误识别的语气词
// 可以按模型类型扩展，新增模型时在此添加对应的幻觉词
const ASR_HALLUCINATION_WORDS: Record<string, Set<string>> = {
  // 通用幻觉词（所有模型共享）
  common: new Set([
    "嗯", "啊", "呃", "哦", "噢",
    "the", "um", "uh", "hmm", "mhm",
  ]),
  // MiMo 模型特有的幻觉词
  mimo: new Set([
    "嗯嗯", "啊啊", "呃呃", "uh-huh",
  ]),
  // DashScope 模型特有的幻觉词
  dashscope: new Set([
    "嗯嗯", "啊啊",
  ]),
};

/**
 * 获取指定模型的幻觉词集合
 */
function getHallucinationWords(model: string): Set<string> {
  const isDashScope = getAsrTransport(model) === "dashscope";
  const modelKey = isDashScope ? "dashscope" : "mimo";

  return new Set([
    ...ASR_HALLUCINATION_WORDS.common,
    ...(ASR_HALLUCINATION_WORDS[modelKey] || []),
  ]);
}

export type AsrPhase =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "transcribing"
  | "done"
  | "error";

export type { AsrError, AsrErrorCode } from "@/lib/asrRuntime";

export interface UseVoiceRecognitionOptions {
  apiKey: string;
  authMode?: MimoAuthMode;
  model: string;
  region?: DashScopeRegion;
  onResult: (text: string) => void;
  onError?: (err: AsrError) => void;
  maxDurationMs?: number;
}

export interface UseVoiceRecognitionReturn {
  phase: AsrPhase;
  elapsedMs: number;
  level: number;
  errorMessage: string | null;
  lastText: string;
  isSupported: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

const LOCALIZED_ASR_ERROR_KEYS: Partial<Record<AsrError["code"], string>> = {
  permission_denied: "settings.voice.permissionDenied",
  no_microphone: "settings.voice.noMicrophone",
  no_api_key: "settings.voice.noApiKey",
  not_supported: "settings.voice.notSupported",
  network: "settings.voice.networkError",
  http_5xx: "settings.voice.serviceUnavailable",
  timeout: "settings.voice.timeout",
  empty_audio: "settings.voice.emptyAudio",
};

function localizeAsrError(error: AsrError): AsrError {
  const key = LOCALIZED_ASR_ERROR_KEYS[error.code];
  if (!key) {
    return error;
  }
  return {
    ...error,
    message: i18n.t(key, { defaultValue: error.message }),
  };
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

function isCorsLikeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message || "";
  return /Failed to fetch|NetworkError|network request failed/i.test(msg);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result || ""));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function classifyHttpError(status: number, fallbackMessage: string): AsrError {
  if (status === 401) {
    return { code: "http_4xx", message: "API Key 无效或已过期" };
  }
  if (status === 403) {
    return { code: "http_4xx", message: "API Key 没有访问权限" };
  }
  if (status === 429) {
    return { code: "http_4xx", message: "调用频率超限，请稍后再试" };
  }
  if (status === 404) {
    return { code: "http_4xx", message: fallbackMessage || "当前模型不存在，或当前接口不支持该模型" };
  }
  if (status >= 500) {
    return { code: "http_5xx", message: "服务暂时不可用" };
  }
  return { code: "http_4xx", message: fallbackMessage || `请求失败 (${status})` };
}

function getAudioContextConstructor():
  | (new (contextOptions?: AudioContextOptions) => AudioContext)
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const { length, numberOfChannels } = audioBuffer;
  if (numberOfChannels <= 1) {
    return audioBuffer.getChannelData(0).slice();
  }

  const output = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const input = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      output[i] += input[i] / numberOfChannels;
    }
  }
  return output;
}

function encodeMono16BitPcmWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, value, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: MIMO_ASR_UPLOAD_MIME_TYPE });
}

async function convertBlobToWav(blob: Blob): Promise<Blob> {
  if (blob.type === MIMO_ASR_UPLOAD_MIME_TYPE) {
    return blob;
  }

  const AudioCtor = getAudioContextConstructor();
  if (!AudioCtor) {
    throw new Error("当前环境不支持语音格式转换");
  }

  // 使用 16kHz 采样率 - ASR 标准采样率，平衡质量和文件大小
  const ctx = new AudioCtor({ sampleRate: 16_000 });
  try {
    const sourceBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(sourceBuffer.slice(0));
    return encodeMono16BitPcmWav(mixAudioBufferToMono(audioBuffer), 16_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(message || "录音格式转换失败");
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

async function prepareAudioForAsr(blob: Blob): Promise<{
  audioBase64: string;
  audioDataUrl: string;
  mimeType: string;
}> {
  const audioBlob = await convertBlobToWav(blob);
  const audioDataUrl = await blobToDataUrl(audioBlob);
  const separatorIndex = audioDataUrl.indexOf(",");
  const audioBase64 = separatorIndex >= 0 ? audioDataUrl.slice(separatorIndex + 1) : "";
  return {
    audioBase64,
    audioDataUrl,
    mimeType: audioBlob.type || MIMO_ASR_UPLOAD_MIME_TYPE,
  };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithRustProxy(
  audioBase64: string,
  mimeType: string,
  model: string,
  apiKey: string,
  authMode: MimoAuthMode,
): Promise<string> {
  const result = await invoke<string>("transcribe_audio", {
    audioBase64,
    mimeType,
    model,
    apiKey,
    authMode,
  });
  return (result || "").trim();
}

/**
 * 使用 DashScope 原生接口转录音频
 */
async function transcribeWithDashScope(
  audioDataUrl: string,
  model: DashScopeAsrModel,
  apiKey: string,
  region: DashScopeRegion = "beijing",
  workspaceId?: string,
): Promise<string> {
  const endpoint = getDashScopeEndpoint(region, workspaceId);
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildDashScopeAsrRequest(audioDataUrl, { model, region }),
      ),
    },
    TRANSCRIBE_TIMEOUT_MS,
  );

  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.json();
    } catch {
      // ignore parse failure
    }
    throw classifyHttpError(res.status, extractDashScopeApiErrorMessage(errBody));
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return extractDashScopeAsrText(await res.json());
  }
  return (await res.text()).trim();
}

/**
 * 使用 OpenAI 兼容接口转录音频
 */
async function transcribeWithOpenAICompatible(
  audioDataUrl: string,
  model: DashScopeAsrModel,
  apiKey: string,
  region: DashScopeRegion = "beijing",
  workspaceId?: string,
): Promise<string> {
  const endpoint = getOpenAICompatibleEndpoint(region, workspaceId);
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildOpenAICompatibleAsrRequest(audioDataUrl, { model, region }),
      ),
    },
    TRANSCRIBE_TIMEOUT_MS,
  );

  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.json();
    } catch {
      // ignore parse failure
    }
    throw classifyHttpError(res.status, extractDashScopeApiErrorMessage(errBody));
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return extractDashScopeAsrText(await res.json());
  }
  return (await res.text()).trim();
}

export function useVoiceRecognition(
  options: UseVoiceRecognitionOptions,
): UseVoiceRecognitionReturn {
  const { apiKey, authMode = "token-plan", model, region = "beijing", onResult, onError, maxDurationMs = MAX_AUTO_DURATION_MS } =
    options;

  const [phase, setPhase] = useState<AsrPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastText, setLastText] = useState("");

  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined";

  const phaseRef = useRef<AsrPhase>("idle");
  const apiKeyRef = useRef(apiKey);
  const authModeRef = useRef(authMode);
  const regionRef = useRef(region);
  const modelRef = useRef(model);
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelBufferRef = useRef<Uint8Array | null>(null);

  const setPhaseRef = useCallback((next: AsrPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  useEffect(() => {
    authModeRef.current = authMode;
  }, [authMode]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    regionRef.current = region;
  }, [region]);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stopTimers = useCallback(() => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const clearAutoResetTimer = useCallback(() => {
    if (autoResetTimerRef.current) {
      clearTimeout(autoResetTimerRef.current);
      autoResetTimerRef.current = null;
    }
  }, []);

  const scheduleAutoResetToIdle = useCallback(
    (expectedPhase: Extract<AsrPhase, "done" | "error">, delayMs: number) => {
      clearAutoResetTimer();
      autoResetTimerRef.current = setTimeout(() => {
        autoResetTimerRef.current = null;
        if (!mountedRef.current) {
          return;
        }
        if (phaseRef.current === expectedPhase) {
          setPhaseRef("idle");
        }
      }, delayMs);
    },
    [clearAutoResetTimer, setPhaseRef],
  );

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    levelBufferRef.current = null;
  }, []);

  const emitError = useCallback(
    (err: AsrError) => {
      const localizedError = localizeAsrError(err);
      setErrorMessage(localizedError.message);
      setPhaseRef("error");
      scheduleAutoResetToIdle("error", ERROR_SETTLE_MS);
      onErrorRef.current?.(localizedError);
    },
    [scheduleAutoResetToIdle, setPhaseRef],
  );

  const reset = useCallback(() => {
    stopTimers();
    clearAutoResetTimer();
    releaseStream();
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      mediaRecorderRef.current = null;
    }
    setLevel(0);
    setElapsedMs(0);
  }, [clearAutoResetTimer, releaseStream, stopTimers]);
  void reset; // reserved for future reset flows

  const transcribe = useCallback(
    async (blob: Blob) => {
      setPhaseRef("transcribing");
      const currentModel = modelRef.current;
      const currentAuthMode = authModeRef.current;
      const currentRegion = regionRef.current;
      const transport = getAsrTransport(currentModel);

      try {
        const preparedAudio = await prepareAudioForAsr(blob);
        let text = "";

        if (transport === "dashscope") {
          // DashScope 模型：使用 OpenAI 兼容接口
          try {
            text = await transcribeWithOpenAICompatible(
              preparedAudio.audioDataUrl,
              currentModel as DashScopeAsrModel,
              apiKeyRef.current,
              currentRegion,
            );
          } catch (dashScopeErr) {
            // 如果 OpenAI 兼容接口失败，尝试使用原生接口
            if (isCorsLikeError(dashScopeErr)) {
              text = await transcribeWithDashScope(
                preparedAudio.audioDataUrl,
                currentModel as DashScopeAsrModel,
                apiKeyRef.current,
                currentRegion,
              );
            } else {
              throw dashScopeErr;
            }
          }
        } else {
          // MiMo 始终使用 Rust 代理，与设置页连接测试保持同一请求路径。
          text = await transcribeWithRustProxy(
            preparedAudio.audioBase64,
            preparedAudio.mimeType,
            currentModel,
            apiKeyRef.current,
            currentAuthMode,
          );
        }

        // 去除 ASR 模型常见的尾部幻觉字符（如多余的斜杠、反斜杠等）
        const sanitized = text.replace(/[/\\]+$/, "").trim();

        // 过滤 ASR 幻觉词（静音时模型误识别的语气词）
        const hallucinationWords = getHallucinationWords(currentModel);
        if (!sanitized || hallucinationWords.has(sanitized)) {
          emitError({ code: "empty_audio", message: "未识别到语音内容" });
          return;
        }
        setLastText(sanitized);
        setPhaseRef("done");
        onResultRef.current?.(sanitized);
        scheduleAutoResetToIdle("done", SUCCESS_SETTLE_MS);
      } catch (err) {
        let asrError: AsrError;
        if (err instanceof Error) {
          if (err.name === "AbortError") {
            asrError = { code: "timeout", message: "转录超时" };
          } else if (isCorsLikeError(err)) {
            asrError = {
              code: "network",
              message: "网络错误，请检查连接",
            };
          } else {
            asrError = normalizeAsrError(err);
          }
        } else {
          asrError = normalizeAsrError(err);
        }
        emitError(asrError);
      }
    },
    [emitError, scheduleAutoResetToIdle, setPhaseRef],
  );

  const start = useCallback(async () => {
    if (!isSupported) {
      emitError({ code: "not_supported", message: "当前环境不支持录音" });
      return;
    }
    if (!apiKeyRef.current.trim()) {
      emitError({ code: "no_api_key", message: "请先在设置中配置语音识别 API Key" });
      return;
    }
    if (
      phaseRef.current === "recording" ||
      phaseRef.current === "transcribing" ||
      phaseRef.current === "requesting_permission"
    ) {
      return; // idempotent
    }

    clearAutoResetTimer();
    setErrorMessage(null);
    chunksRef.current = [];
    setPhaseRef("requesting_permission");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Audio analysis for level meter
      try {
        const AudioCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AudioCtor();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        // Cast through unknown to align with Web Audio typings on TS 5.7+
        const buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        levelBufferRef.current = buf as unknown as Uint8Array<ArrayBuffer>;
      } catch {
        // Non-fatal: level meter is optional
      }

      const mimeType = pickMimeType();
      mimeTypeRef.current = mimeType;
      // 设置音频比特率为 64kbps，适合语音识别
      const recorderOptions: MediaRecorderOptions = {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000,
      };
      const recorder = new MediaRecorder(stream, recorderOptions);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeTypeRef.current || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        stopTimers();
        releaseStream();
        mediaRecorderRef.current = null;
        if (blob.size === 0) {
          emitError({ code: "empty_audio", message: "未识别到语音内容" });
          return;
        }
        void transcribe(blob);
      };
      recorder.onerror = (event) => {
        const errEvent = event as unknown as { error?: { name?: string; message?: string } };
        const name = errEvent.error?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          emitError({ code: "permission_denied", message: "麦克风权限被拒绝" });
        } else if (name === "NotFoundError") {
          emitError({ code: "no_microphone", message: "未检测到可用麦克风" });
        } else {
          emitError({ code: "unknown", message: errEvent.error?.message || "录音失败" });
        }
        stopTimers();
        releaseStream();
      };

      recorder.start(250);
      recordingStartRef.current = Date.now();
      setPhaseRef("recording");

      // Level meter
      levelTimerRef.current = setInterval(() => {
        if (analyserRef.current && levelBufferRef.current) {
          // getByteFrequencyData accepts Uint8Array<ArrayBuffer>; our buffer is
          // already that shape at runtime — cast to satisfy TS 5.7+ strictness.
          analyserRef.current.getByteFrequencyData(
            levelBufferRef.current as unknown as Uint8Array<ArrayBuffer>,
          );
          let sum = 0;
          const buf = levelBufferRef.current;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          const avg = sum / buf.length / 255;
          setLevel(avg);
        }
      }, LEVEL_POLL_INTERVAL_MS);

      // Elapsed time
      elapsedTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - recordingStartRef.current);
      }, 200);

      // Auto stop after max duration
      autoStopTimerRef.current = setTimeout(() => {
        if (
          mediaRecorderRef.current &&
          mediaRecorderRef.current.state === "recording"
        ) {
          mediaRecorderRef.current.stop();
        }
      }, maxDurationMs);
    } catch (err) {
      stopTimers();
      releaseStream();
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "SecurityError") {
          emitError({ code: "permission_denied", message: "麦克风权限被拒绝" });
        } else if (err.name === "NotFoundError") {
          emitError({ code: "no_microphone", message: "未检测到可用麦克风" });
        } else {
          emitError({ code: "unknown", message: err.message || "录音启动失败" });
        }
      } else {
        emitError({ code: "unknown", message: "录音启动失败" });
      }
    }
  }, [clearAutoResetTimer, emitError, isSupported, maxDurationMs, releaseStream, setPhaseRef, stopTimers, transcribe]);

  const stop = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    stopTimers();
    clearAutoResetTimer();
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.ondataavailable = null;
          mediaRecorderRef.current.onstop = null;
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      mediaRecorderRef.current = null;
    }
    chunksRef.current = [];
    releaseStream();
    setLevel(0);
    setElapsedMs(0);
    setPhaseRef("idle");
  }, [clearAutoResetTimer, releaseStream, setPhaseRef, stopTimers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimers();
      clearAutoResetTimer();
      if (mediaRecorderRef.current) {
        try {
          if (mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
          }
        } catch {
          // ignore
        }
        mediaRecorderRef.current = null;
      }
      releaseStream();
    };
  }, [clearAutoResetTimer, releaseStream, stopTimers]);

  return {
    phase,
    elapsedMs,
    level,
    errorMessage,
    lastText,
    isSupported,
    start,
    stop,
    cancel,
  };
}
