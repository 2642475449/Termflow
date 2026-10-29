import { lazy, Suspense, useEffect } from "react";
import { DeleteOutlined, CloseOutlined, MinusOutlined, FullscreenExitOutlined, FullscreenOutlined,
  ReloadOutlined, StopOutlined, VerticalAlignBottomOutlined, EnterOutlined, ClearOutlined } from "@ant-design/icons";
import { Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { EMPTY_RUNNER_TABS, isRunnerRunning, useBottomRunnerStore } from "@/store/slices/bottomRunner";
import { clearFinishedRunnerTabs, closeRunnerTab, completeRunner, markRunnerTerminalReady,
  rerunRunner, stopRunner } from "@/store/slices/bottomRunnerRuntime";
import { BottomRunnerDivider, syncRunnerLayout } from "./BottomRunnerDivider";
import { RunnerStatusIcon } from "./BottomRunnerStatus";
import "./bottomRunner.css";

const Terminal = lazy(() => import("../Terminal"));

export function BottomRunnerPanel() {
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path ?? "");
  const store = useBottomRunnerStore();
  const tabs = store.tabsByProject[projectPath] ?? EMPTY_RUNNER_TABS;
  const active = tabs.find((tab) => tab.id === store.activeTabIdByProject[projectPath]);
  useEffect(() => { store.handleProjectChange(projectPath); }, [projectPath, store.handleProjectChange]);
  useEffect(() => {
    const onResize = () => {
      const state = useBottomRunnerStore.getState();
      state.setHeight(state.height);
      syncRunnerLayout();
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => { syncRunnerLayout(); }, [store.open, store.height, store.maximized, projectPath, active?.id]);

  const runAction = (operation: Promise<void>) => {
    void operation.catch((error: unknown) => message.error(t("bottomRunner.launchFailed", { error: String(error) })));
  };
  const clear = () => {
    if (active) window.dispatchEvent(new CustomEvent("terminal:clear", { detail: { sessionId: active.sessionId } }));
  };
  const tool = (key: string, icon: React.ReactNode, onClick: () => void, disabled = false, pressed?: boolean) => (
    <Tooltip key={key} title={t(`bottomRunner.${key}`)}>
      <button type="button" className="app-bottom-runner-tool flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm"
        aria-label={t(`bottomRunner.${key}`)} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon}</button>
    </Tooltip>
  );
  return <>
    {/* 运行时高度通过独立样式规则赋值，组件不使用内联 style 属性。 */}
    <style>{`.app-bottom-runner-panel { height: ${store.height}px; }`}</style>
    <section aria-label={t("bottomRunner.title")} data-open={store.open} data-maximized={store.maximized} data-word-wrap={store.wordWrap}
      className="app-bottom-runner-panel min-h-0 shrink-0 flex-col"
      onMouseDown={(event) => { if (!(event.target as HTMLElement).closest(".xterm")) event.preventDefault(); }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (event.key.toLowerCase() === "k" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); clear(); }
        if (event.key.toLowerCase() === "r" && event.shiftKey && active) {
          event.preventDefault(); event.stopPropagation(); runAction(rerunRunner(active));
        }
      }}>
      <BottomRunnerDivider activeSessionId={active?.sessionId} />
      <div className="app-bottom-runner-header flex min-h-9 shrink-0 items-center gap-2 px-2">
        <span className="shrink-0 text-xs font-medium">{t("bottomRunner.title")}</span>
        <div role="tablist" aria-label={t("bottomRunner.title")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => <div key={tab.id} className="app-bottom-runner-tab flex shrink-0 items-center rounded" data-active={tab.id === active?.id}>
            <button role="tab" id={tab.id} aria-controls={`output:${tab.sessionId}`} aria-selected={tab.id === active?.id}
              type="button" className="flex max-w-56 items-center gap-1.5 px-2 py-1 text-xs" title={t(`bottomRunner.status.${tab.status}`, { code: tab.exitCode })}
              onClick={() => store.activateTab(projectPath, tab.id)}>
              <RunnerStatusIcon status={tab.status} /><span className="truncate">{tab.commandLabel}</span>
            </button>
            <button type="button" className="app-bottom-runner-tool flex h-6 w-6 items-center justify-center rounded text-xs"
              aria-label={t("bottomRunner.closeTabName", { name: tab.commandLabel })} title={t("bottomRunner.closeTab")}
              onClick={() => runAction(closeRunnerTab(tab))}><CloseOutlined /></button>
          </div>)}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tool("rerun", <ReloadOutlined />, () => active && runAction(rerunRunner(active)), !active || active.status === "starting")}
          {tool("stop", <StopOutlined />, () => active && runAction(stopRunner(active)), !active || !isRunnerRunning(active))}
          {tool("clear", <DeleteOutlined />, clear, !active)}
          <span aria-hidden="true" className="app-bottom-runner-tool-divider mx-1 h-4" />
          {tool("autoScroll", <VerticalAlignBottomOutlined />, store.toggleAutoScroll, false, store.autoScroll)}
          {tool("wordWrap", <EnterOutlined />, store.toggleWordWrap, false, store.wordWrap)}
          <span aria-hidden="true" className="app-bottom-runner-tool-divider mx-1 h-4" />
          {tool("clearFinished", <ClearOutlined />, () => runAction(clearFinishedRunnerTabs(projectPath)), !tabs.some((tab) => !isRunnerRunning(tab)))}
          {tool(store.maximized ? "restore" : "maximize", store.maximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />, store.toggleMaximized)}
          {tool("collapse", <MinusOutlined />, () => store.setOpen(false))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!active && <div className="flex h-full items-center justify-center text-xs">{t("bottomRunner.noActiveRun")}</div>}
        {/* 折叠、切换标签/工程仅隐藏 DOM，保留日志、OSC 解析与 PTY 输出监听。 */}
        {Object.values(store.tabsByProject).flat().map((tab) => <div key={tab.sessionId} role="tabpanel"
          id={`output:${tab.sessionId}`} aria-labelledby={tab.id}
          className={tab.sessionId === active?.sessionId ? "absolute inset-0" : "hidden"}>
          <Suspense fallback={null}><Terminal sessionId={tab.sessionId}
            allowIndependentFocus={store.open && tab.sessionId === active?.sessionId}
            runnerOptions={{ autoScroll: store.autoScroll, wordWrap: store.wordWrap,
              onAutoScrollChange: store.setAutoScroll, onReady: markRunnerTerminalReady, onCommandComplete: completeRunner }} />
          </Suspense>
        </div>)}
      </div>
    </section>
  </>;
}
