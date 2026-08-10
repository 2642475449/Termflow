import type { NotificationSoundType } from "@/store";

let sharedAudioContext: AudioContext | null = null;

type SoundOption = {
  value: NotificationSoundType;
  labelKey: string;
  descKey: string;
};

type ToneSpec = {
  start: number;
  duration: number;
  frequency: number;
  frequencyEnd?: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  release?: number;
  detune?: number;
  filterFrequency?: number;
  filterQ?: number;
};

export const SOUND_OPTIONS: SoundOption[] = [
  { value: "glass", labelKey: "sounds.glass", descKey: "sounds.glassDesc" },
  { value: "bloom", labelKey: "sounds.bloom", descKey: "sounds.bloomDesc" },
  { value: "pebble", labelKey: "sounds.pebble", descKey: "sounds.pebbleDesc" },
  { value: "pulse", labelKey: "sounds.pulse", descKey: "sounds.pulseDesc" },
  { value: "signal", labelKey: "sounds.signal", descKey: "sounds.signalDesc" },
  { value: "slate", labelKey: "sounds.slate", descKey: "sounds.slateDesc" },
  { value: "aurora", labelKey: "sounds.aurora", descKey: "sounds.auroraDesc" },
  { value: "hush", labelKey: "sounds.hush", descKey: "sounds.hushDesc" },
  { value: "default", labelKey: "sounds.default", descKey: "sounds.defaultDesc" },
  { value: "waiting", labelKey: "sounds.waiting", descKey: "sounds.waitingDesc" },
  { value: "alert", labelKey: "sounds.alert", descKey: "sounds.alertDesc" },
  { value: "chime", labelKey: "sounds.chime", descKey: "sounds.chimeDesc" },
  { value: "bell", labelKey: "sounds.bell", descKey: "sounds.bellDesc" },
];

function getAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContextCtor();
  }
  return sharedAudioContext;
}

function createOutputGain(ctx: AudioContext) {
  const output = ctx.createGain();
  output.connect(ctx.destination);
  output.gain.value = 0.5;
  return output;
}

function scheduleTone(ctx: AudioContext, destination: AudioNode, spec: ToneSpec) {
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const start = ctx.currentTime + spec.start;
  const end = start + spec.duration;
  const attack = Math.min(spec.attack ?? 0.01, spec.duration * 0.45);
  const peakGain = Math.max(0.0001, spec.gain ?? 0.18);

  oscillator.type = spec.type ?? "sine";
  oscillator.frequency.setValueAtTime(spec.frequency, start);
  if (typeof spec.frequencyEnd === "number") {
    oscillator.frequency.linearRampToValueAtTime(spec.frequencyEnd, end);
  }
  oscillator.detune.setValueAtTime(spec.detune ?? 0, start);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(spec.filterFrequency ?? 2400, start);
  filter.Q.value = spec.filterQ ?? 0.8;

  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.linearRampToValueAtTime(peakGain, start + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(destination);
  oscillator.start(start);
  oscillator.stop(end);
}

function scheduleNoiseBurst(
  ctx: AudioContext,
  destination: AudioNode,
  {
    start,
    duration,
    gain,
    highpass = 800,
    lowpass = 3200,
  }: {
    start: number;
    duration: number;
    gain: number;
    highpass?: number;
    lowpass?: number;
  }
) {
  const sampleCount = Math.max(1, Math.ceil(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  const hp = ctx.createBiquadFilter();
  const lp = ctx.createBiquadFilter();
  const gainNode = ctx.createGain();
  const beginAt = ctx.currentTime + start;
  const endAt = beginAt + duration;

  source.buffer = buffer;
  hp.type = "highpass";
  hp.frequency.value = highpass;
  lp.type = "lowpass";
  lp.frequency.value = lowpass;
  gainNode.gain.setValueAtTime(0.0001, beginAt);
  gainNode.gain.linearRampToValueAtTime(Math.max(0.0001, gain), beginAt + Math.min(0.01, duration * 0.35));
  gainNode.gain.exponentialRampToValueAtTime(0.0001, endAt);

  source.connect(hp);
  hp.connect(lp);
  lp.connect(gainNode);
  gainNode.connect(destination);
  source.start(beginAt);
  source.stop(endAt);
}

function playDefault(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.16, frequency: 523, frequencyEnd: 610, gain: 0.12, type: "triangle", filterFrequency: 2600 });
  scheduleTone(ctx, destination, { start: 0.12, duration: 0.26, frequency: 659, frequencyEnd: 784, gain: 0.13, type: "sine", filterFrequency: 3200 });
}

function playWaiting(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.14, frequency: 392, frequencyEnd: 440, gain: 0.09, type: "sine", filterFrequency: 2200 });
  scheduleTone(ctx, destination, { start: 0.18, duration: 0.18, frequency: 440, frequencyEnd: 523, gain: 0.1, type: "triangle", filterFrequency: 2500 });
}

function playAlert(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.09, frequency: 740, gain: 0.12, type: "square", filterFrequency: 1700, filterQ: 1.2 });
  scheduleTone(ctx, destination, { start: 0.13, duration: 0.09, frequency: 740, gain: 0.12, type: "square", filterFrequency: 1700, filterQ: 1.2 });
  scheduleTone(ctx, destination, { start: 0.26, duration: 0.15, frequency: 698, frequencyEnd: 622, gain: 0.13, type: "square", filterFrequency: 1500, filterQ: 1.1 });
}

function playChime(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.42, frequency: 880, frequencyEnd: 1046, gain: 0.11, type: "sine", filterFrequency: 3600 });
  scheduleTone(ctx, destination, { start: 0.02, duration: 0.48, frequency: 1320, gain: 0.045, type: "triangle", detune: 7, filterFrequency: 4200 });
}

function playBell(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.55, frequency: 659, gain: 0.11, type: "triangle", filterFrequency: 2400 });
  scheduleTone(ctx, destination, { start: 0.03, duration: 0.62, frequency: 987, gain: 0.05, type: "sine", detune: 4, filterFrequency: 3200 });
}

function playGlass(ctx: AudioContext, destination: AudioNode) {
  scheduleNoiseBurst(ctx, destination, { start: 0, duration: 0.045, gain: 0.022, highpass: 1800, lowpass: 5200 });
  scheduleTone(ctx, destination, { start: 0, duration: 0.22, frequency: 1180, frequencyEnd: 1320, gain: 0.07, type: "triangle", filterFrequency: 3800 });
  scheduleTone(ctx, destination, { start: 0.02, duration: 0.28, frequency: 1660, gain: 0.035, type: "sine", detune: 5, filterFrequency: 4600 });
}

function playBloom(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.18, frequency: 554, frequencyEnd: 659, gain: 0.09, type: "triangle", filterFrequency: 2400 });
  scheduleTone(ctx, destination, { start: 0.12, duration: 0.32, frequency: 659, frequencyEnd: 830, gain: 0.11, type: "sine", filterFrequency: 3200 });
  scheduleTone(ctx, destination, { start: 0.14, duration: 0.44, frequency: 987, gain: 0.03, type: "sine", detune: 6, filterFrequency: 4200 });
}

function playPebble(ctx: AudioContext, destination: AudioNode) {
  scheduleNoiseBurst(ctx, destination, { start: 0, duration: 0.03, gain: 0.028, highpass: 1200, lowpass: 2800 });
  scheduleTone(ctx, destination, { start: 0, duration: 0.08, frequency: 480, frequencyEnd: 430, gain: 0.08, type: "triangle", filterFrequency: 1600 });
  scheduleTone(ctx, destination, { start: 0.09, duration: 0.09, frequency: 610, frequencyEnd: 560, gain: 0.05, type: "sine", filterFrequency: 2200 });
}

function playPulse(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.16, frequency: 440, frequencyEnd: 494, gain: 0.08, type: "sine", filterFrequency: 2100 });
  scheduleTone(ctx, destination, { start: 0.19, duration: 0.2, frequency: 494, frequencyEnd: 554, gain: 0.09, type: "triangle", filterFrequency: 2400 });
}

function playSignal(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.07, frequency: 932, gain: 0.1, type: "square", filterFrequency: 2000, filterQ: 1.1 });
  scheduleTone(ctx, destination, { start: 0.11, duration: 0.07, frequency: 880, gain: 0.1, type: "square", filterFrequency: 1900, filterQ: 1.1 });
  scheduleTone(ctx, destination, { start: 0.22, duration: 0.18, frequency: 698, frequencyEnd: 622, gain: 0.12, type: "triangle", filterFrequency: 1700, filterQ: 0.9 });
}

function playSlate(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.14, frequency: 392, frequencyEnd: 370, gain: 0.07, type: "triangle", filterFrequency: 1300 });
  scheduleTone(ctx, destination, { start: 0.1, duration: 0.24, frequency: 523, frequencyEnd: 494, gain: 0.06, type: "sine", filterFrequency: 1700 });
}

function playAurora(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.2, frequency: 740, frequencyEnd: 880, gain: 0.08, type: "sine", filterFrequency: 2800 });
  scheduleTone(ctx, destination, { start: 0.08, duration: 0.36, frequency: 988, frequencyEnd: 1174, gain: 0.045, type: "triangle", filterFrequency: 3800, detune: 4 });
  scheduleTone(ctx, destination, { start: 0.11, duration: 0.28, frequency: 1480, gain: 0.02, type: "sine", filterFrequency: 4800 });
}

function playHush(ctx: AudioContext, destination: AudioNode) {
  scheduleTone(ctx, destination, { start: 0, duration: 0.12, frequency: 330, frequencyEnd: 349, gain: 0.045, type: "sine", filterFrequency: 1100 });
  scheduleTone(ctx, destination, { start: 0.16, duration: 0.14, frequency: 349, frequencyEnd: 392, gain: 0.05, type: "triangle", filterFrequency: 1400 });
}

const SOUND_PLAYERS: Record<NotificationSoundType, (ctx: AudioContext, destination: AudioNode) => void> = {
  default: playDefault,
  waiting: playWaiting,
  alert: playAlert,
  chime: playChime,
  bell: playBell,
  glass: playGlass,
  bloom: playBloom,
  pebble: playPebble,
  pulse: playPulse,
  signal: playSignal,
  slate: playSlate,
  aurora: playAurora,
  hush: playHush,
};

export function playNotificationSound(type: NotificationSoundType) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
    const output = createOutputGain(ctx);
    SOUND_PLAYERS[type](ctx, output);
    window.setTimeout(() => output.disconnect(), 1500);
  } catch {
    // AudioContext not available
  }
}

export const SOUND_LABELS: Record<NotificationSoundType, string> = {
  default: "sounds.default",
  waiting: "sounds.waiting",
  alert: "sounds.alert",
  chime: "sounds.chime",
  bell: "sounds.bell",
  glass: "sounds.glass",
  bloom: "sounds.bloom",
  pebble: "sounds.pebble",
  pulse: "sounds.pulse",
  signal: "sounds.signal",
  slate: "sounds.slate",
  aurora: "sounds.aurora",
  hush: "sounds.hush",
};

export const EVENT_LABELS: Record<string, string> = {
  taskComplete: "sounds.taskComplete",
  error: "sounds.error",
  waiting: "sounds.waitingEvent",
};
