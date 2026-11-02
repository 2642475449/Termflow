import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useAppStore } from "@/store";
import { getTerminalTheme } from "@/lib/terminalTheme";
import { createTerminalInputQueue } from "@/lib/terminalInputQueue";
import { createTerminalImeOutputGate } from "@/lib/terminalImeOutput";
import { createPtyResizeGate } from "@/lib/terminalResize";
import { decodeRemoteOutput, reconcileRemoteRead, remoteErrorText, type RemoteSession } from "@/lib/remote";
import {
  getRemoteConnectionGeneration, readRemoteSession, resizeRemoteSession, sendRemoteAuthentication, useRemoteWorkspaceStore, writeRemoteSession,
} from "@/store/slices/remoteWorkspace";
import "@xterm/xterm/css/xterm.css";

interface RemoteTerminalProps {
  hostId: string;
  session: RemoteSession;
  active: boolean;
}

/** 仅承担远端字节流，不挂载本地文件链接、检查点或本地会话恢复逻辑。 */
export function RemoteTerminal({ hostId, session, active }: RemoteTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const sessionRef = useRef(session);
  const cursorRef = useRef(0);
  const activeRef = useRef(active);
  const fitRef = useRef<(() => void) | null>(null);
  const theme = useAppStore((state) => state.activeTheme());
  const fontSize = useAppStore((state) => state.terminalFontSize);
  const cursorBlink = useAppStore((state) => state.terminalCursorBlink);
  const lineHeight = useAppStore((state) => state.terminalLineHeight);
  const connection = useRemoteWorkspaceStore((state) => state.connections[hostId]);
  sessionRef.current = session;
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const settings = useAppStore.getState();
    const colors = getTerminalTheme(settings.activeTheme());
    const term = new XTerm({
      theme: colors.theme, minimumContrastRatio: colors.minimumContrastRatio,
      fontSize: settings.terminalFontSize, lineHeight: settings.terminalLineHeight,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      cursorBlink: settings.terminalCursorBlink, scrollback: settings.terminalScrollback,
      allowProposedApi: false, disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    cursorRef.current = 0;
    let decoder = new TextDecoder();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enqueueInput = createTerminalInputQueue();
    const output = createTerminalImeOutputGate((data) => term.write(data));
    const resize = createPtyResizeGate((rows, cols) => {
      if (useRemoteWorkspaceStore.getState().connections[hostId]?.state !== "connected") return;
      void resizeRemoteSession(hostId, sessionRef.current, rows, cols).catch((error: unknown) => {
        useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
      });
    });
    const fitTerminal = () => {
      if (!activeRef.current || container.clientWidth < 16 || container.clientHeight < 16) return;
      fit.fit();
      if (sessionRef.current.processState === "running" && useRemoteWorkspaceStore.getState().connections[hostId]?.state === "connected") resize(term.rows, term.cols);
    };
    fitRef.current = fitTerminal;
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(container);
    const onData = term.onData((data) => {
      // 每一笔输入在入队和真正发送前均校验连接；断线期间绝不缓存按键。
      if (useRemoteWorkspaceStore.getState().connections[hostId]?.state !== "connected") return;
      const generation = getRemoteConnectionGeneration(hostId);
      const inputSession = sessionRef.current;
      void enqueueInput(async () => {
        if (generation !== getRemoteConnectionGeneration(hostId)) throw new Error("remote.errors.inputDiscarded");
        await writeRemoteSession(hostId, inputSession, data);
      }).catch((error: unknown) => {
        useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
      });
    });
    const onCompositionStart = () => output.compositionStart();
    const onCompositionEnd = () => output.compositionEnd();
    container.addEventListener("compositionstart", onCompositionStart);
    container.addEventListener("compositionend", onCompositionEnd);
    const read = async () => {
      const state = useRemoteWorkspaceStore.getState();
      let delay = 150;
      if (activeRef.current && state.connections[hostId]?.state === "connected") {
        try {
          const current = sessionRef.current;
          const result = await readRemoteSession(hostId, current, cursorRef.current);
          if (disposed) return;
          const decision = reconcileRemoteRead(result, { sessionId: current.id, instanceId: current.instanceId, cursor: cursorRef.current });
          if (decision !== "ignore") {
            if (decision === "reset") {
              term.reset();
              decoder = new TextDecoder();
              if (result.truncated) useRemoteWorkspaceStore.getState().setError(hostId, "remote.sessions.outputTruncated");
            }
            if (result.data) output.write(decoder.decode(decodeRemoteOutput(result.data), { stream: true }));
            cursorRef.current = result.nextOffset;
            delay = result.nextOffset < result.session.outputEnd ? 0 : 150;
          }
        } catch (error) {
          if (!disposed) useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
          delay = 1000;
        }
      } else delay = 500;
      if (!disposed) timer = setTimeout(() => { void read(); }, delay);
    };
    fitTerminal();
    void read();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      onData.dispose();
      container.removeEventListener("compositionstart", onCompositionStart);
      container.removeEventListener("compositionend", onCompositionEnd);
      output.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // 卸载视图从不向远端发送 stop。
    };
  }, [hostId, session.id, session.instanceId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const colors = getTerminalTheme(theme);
    term.options.theme = colors.theme;
    term.options.minimumContrastRatio = colors.minimumContrastRatio;
    term.options.fontSize = fontSize;
    term.options.cursorBlink = cursorBlink;
    term.options.lineHeight = lineHeight;
    term.options.disableStdin = connection?.state !== "connected" || session.processState !== "running";
    if (active) { fitRef.current?.(); term.focus(); }
  }, [active, connection?.state, cursorBlink, fontSize, lineHeight, session.processState, theme]);

  return <div ref={containerRef} className="app-remote-terminal" data-remote-session={session.id} />;
}

export function RemoteAuthenticationTerminal({ hostId, active }: { hostId: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const previousOutput = useRef("");
  const connection = useRemoteWorkspaceStore((state) => state.connections[hostId]);
  const theme = useAppStore((state) => state.activeTheme());

  useEffect(() => {
    if (!containerRef.current) return;
    const colors = getTerminalTheme(useAppStore.getState().activeTheme());
    const term = new XTerm({
      rows: 8, cols: 100, fontSize: 13, theme: colors.theme, minimumContrastRatio: colors.minimumContrastRatio,
      fontFamily: "'Cascadia Code', Consolas, monospace", scrollback: 1000, cursorBlink: true, reflowCursorLine: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    const fitTerminal = () => { if (containerRef.current && containerRef.current.clientWidth > 16) fit.fit(); };
    fitRef.current = fitTerminal;
    previousOutput.current = "";
    const inputQueue = createTerminalInputQueue();
    const input = term.onData((data) => {
      const generation = getRemoteConnectionGeneration(hostId);
      void inputQueue(async () => {
        if (generation !== getRemoteConnectionGeneration(hostId)) throw new Error("remote.errors.inputDiscarded");
        await sendRemoteAuthentication(hostId, data);
      }).catch((error: unknown) => {
        useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
      });
    });
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(containerRef.current);
    fitTerminal();
    return () => { observer.disconnect(); input.dispose(); term.dispose(); termRef.current = null; fitRef.current = null; };
  }, [hostId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) fitRef.current?.();
    const content = connection?.authOutput ?? "";
    if (content.startsWith(previousOutput.current)) term.write(content.slice(previousOutput.current.length));
    else { term.reset(); term.write(content); }
    previousOutput.current = content;
    term.options.disableStdin = connection?.state !== "authenticating" && connection?.state !== "connecting";
    term.options.theme = getTerminalTheme(theme).theme;
    if (active) term.focus();
  }, [active, connection?.authOutput, connection?.authRevision, connection?.state, theme]);

  return <div className="app-remote-auth-frame"><div ref={containerRef} className="app-remote-auth-terminal" /></div>;
}
