import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVoiceRecognition } from "./useVoiceRecognition";
import { cancelLiveAsr, startLiveAsr } from "@/lib/api";
import { LIVE_DASHSCOPE_ASR_MODEL } from "@/lib/asrRuntime";

// node 环境下只替换 React 的调度，实际执行 Hook 的异步生命周期和取消逻辑。
const state = vi.hoisted(() => ({ values: [] as unknown[] }));
vi.mock("react", () => ({
  useState: <T>(initial: T) => {
    const index = state.values.push(initial) - 1;
    return [initial, (value: T) => { state.values[index] = value; }];
  },
  useRef: <T>(current: T) => ({ current }),
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/api", () => ({
  cancelLiveAsr: vi.fn().mockResolvedValue(undefined),
  startLiveAsr: vi.fn().mockResolvedValue(undefined),
  finishLiveAsr: vi.fn().mockResolvedValue(undefined),
  sendLiveAsrAudio: vi.fn().mockResolvedValue(undefined),
  polishVoiceText: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function microphone() {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}
const getUserMedia = vi.fn();
const recorderStart = vi.fn();
const recorderStop = vi.fn();
class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  start() { this.state = "recording"; recorderStart(); }
  stop() { this.state = "inactive"; recorderStop(); }
}
function createVoice(model = "mimo-v2-flash") {
  const onError = vi.fn();
  const voice = useVoiceRecognition({ apiKey: "test-key", model, onError, onResult: vi.fn() });
  return { voice, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.values = [];
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("window", { MediaRecorder: FakeRecorder });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("松开时立即关闭，并释放稍后才返回的麦克风流", async () => {
  const pending = deferred<MediaStream>();
  const mic = microphone();
  getUserMedia.mockReturnValueOnce(pending.promise);
  const { voice } = createVoice();
  const starting = voice.start();
  expect(state.values[0]).toBe("requesting_permission");
  await voice.stop();
  expect(state.values[0]).toBe("idle");
  pending.resolve(mic.stream);
  await starting;
  expect(mic.stop).toHaveBeenCalledOnce();
  expect(recorderStart).not.toHaveBeenCalled();
  expect(state.values[0]).toBe("idle");
});

it("取消后的权限请求失败不会重新显示错误状态", async () => {
  const pending = deferred<MediaStream>();
  getUserMedia.mockReturnValueOnce(pending.promise);
  const { voice, onError } = createVoice();
  const starting = voice.start();
  voice.cancel();
  pending.reject(new Error("late permission failure"));
  await starting;
  expect(state.values[0]).toBe("idle");
  expect(onError).not.toHaveBeenCalled();
});

it("旧权限请求完成不会影响取消后开始的新录音", async () => {
  const old = deferred<MediaStream>();
  const oldMic = microphone();
  const newMic = microphone();
  getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(newMic.stream);
  const { voice } = createVoice();
  const starting = voice.start();
  await voice.stop();
  await voice.start();
  old.resolve(oldMic.stream);
  await starting;
  expect(oldMic.stop).toHaveBeenCalledOnce();
  expect(newMic.stop).not.toHaveBeenCalled();
  expect(recorderStart).toHaveBeenCalledOnce();
  expect(state.values[0]).toBe("recording");
  voice.cancel();
});

it("建立实时连接时松开，迟到的连接完成不会启动录音", async () => {
  const pending = deferred<void>();
  const mic = microphone();
  getUserMedia.mockResolvedValueOnce(mic.stream);
  vi.mocked(startLiveAsr).mockReturnValueOnce(pending.promise);
  const { voice } = createVoice(LIVE_DASHSCOPE_ASR_MODEL);
  const starting = voice.start();
  await Promise.resolve();
  const sessionId = vi.mocked(startLiveAsr).mock.calls[0][0];
  await voice.stop();
  expect(state.values[0]).toBe("idle");
  expect(mic.stop).toHaveBeenCalledOnce();
  pending.resolve();
  await starting;
  expect(cancelLiveAsr).toHaveBeenLastCalledWith(sessionId);
  expect(recorderStart).not.toHaveBeenCalled();
});

it("正常录音松开仍然停止录音，不走初始化取消", async () => {
  getUserMedia.mockResolvedValueOnce(microphone().stream);
  const { voice } = createVoice();
  await voice.start();
  expect(state.values[0]).toBe("recording");
  await voice.stop();
  expect(recorderStop).toHaveBeenCalledOnce();
  expect(cancelLiveAsr).not.toHaveBeenCalled();
  voice.cancel();
});


it("麦克风启动超时后释放迟到的流，并允许重新录音", async () => {
  const pending = deferred<MediaStream>();
  const oldMic = microphone();
  const newMic = microphone();
  getUserMedia.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newMic.stream);
  const { voice, onError } = createVoice();
  const starting = voice.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(state.values[0]).toBe("error");
  expect(onError).toHaveBeenCalledWith({ code: "unknown", message: "settings.voice.startupTimeout" });
  await voice.start();
  pending.resolve(oldMic.stream);
  await starting;
  expect(oldMic.stop).toHaveBeenCalledOnce();
  expect(newMic.stop).not.toHaveBeenCalled();
  expect(state.values[0]).toBe("recording");
  voice.cancel();
});

it("实时连接启动超时会取消后台会话，旧连接完成不影响新录音", async () => {
  const pending = deferred<void>();
  const oldMic = microphone();
  const newMic = microphone();
  getUserMedia.mockResolvedValueOnce(oldMic.stream).mockResolvedValueOnce(newMic.stream);
  vi.mocked(startLiveAsr).mockReturnValueOnce(pending.promise);
  const { voice } = createVoice(LIVE_DASHSCOPE_ASR_MODEL);
  const starting = voice.start();
  await Promise.resolve();
  const sessionId = vi.mocked(startLiveAsr).mock.calls[0][0];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(cancelLiveAsr).toHaveBeenCalledWith(sessionId);
  expect(oldMic.stop).toHaveBeenCalledOnce();
  await voice.start();
  pending.resolve();
  await starting;
  expect(newMic.stop).not.toHaveBeenCalled();
  expect(recorderStart).toHaveBeenCalledOnce();
  expect(state.values[0]).toBe("recording");
  voice.cancel();
});

it("取消未返回的实时连接后，可以立即开启新的录音", async () => {
  const pending = deferred<void>();
  getUserMedia.mockResolvedValueOnce(microphone().stream).mockResolvedValueOnce(microphone().stream);
  vi.mocked(startLiveAsr).mockReturnValueOnce(pending.promise);
  const { voice, onError } = createVoice(LIVE_DASHSCOPE_ASR_MODEL);
  const starting = voice.start();
  await Promise.resolve();
  voice.cancel();
  await voice.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(state.values[0]).toBe("recording");
  expect(onError).not.toHaveBeenCalled();
  pending.reject(new Error("old connection cancelled"));
  await starting;
  expect(state.values[0]).toBe("recording");
  voice.cancel();
});
