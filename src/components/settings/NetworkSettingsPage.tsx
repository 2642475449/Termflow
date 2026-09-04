import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  GlobalOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Input, Radio, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { resolveNetworkProxySettings, testNetworkProxy } from "@/lib/api";
import {
  NETWORK_PROXY_TEST_TARGETS,
  normalizeNetworkProxySettings,
} from "@/lib/networkProxy";
import { useAppStore } from "@/store";
import type {
  NetworkProxyTestResult,
  NetworkProxyTestTarget,
  ResolvedNetworkProxy,
} from "@/types";

type TestResults = Partial<Record<NetworkProxyTestTarget, NetworkProxyTestResult>>;

export function NetworkSettingsPage() {
  const { t } = useTranslation();
  const networkProxyMode = useAppStore((state) => state.networkProxyMode);
  const networkCustomProxyUrl = useAppStore((state) => state.networkCustomProxyUrl);
  const networkNoProxy = useAppStore((state) => state.networkNoProxy);
  const setNetworkProxyMode = useAppStore((state) => state.setNetworkProxyMode);
  const setNetworkCustomProxyUrl = useAppStore((state) => state.setNetworkCustomProxyUrl);
  const setNetworkNoProxy = useAppStore((state) => state.setNetworkNoProxy);
  const [resolution, setResolution] = useState<ResolvedNetworkProxy | null>(null);
  const [customTestUrl, setCustomTestUrl] = useState("");
  const [results, setResults] = useState<TestResults>({});
  const [runningTargets, setRunningTargets] = useState<Set<NetworkProxyTestTarget>>(new Set());

  const settings = useMemo(() => normalizeNetworkProxySettings({
    mode: networkProxyMode,
    customProxyUrl: networkCustomProxyUrl,
    noProxy: networkNoProxy,
  }), [networkCustomProxyUrl, networkNoProxy, networkProxyMode]);

  useEffect(() => {
    let disposed = false;
    resolveNetworkProxySettings(settings)
      .then((next) => {
        if (disposed) return;
        setResolution(next);
      })
      .catch(() => {
        if (disposed) return;
        setResolution(null);
      });
    return () => {
      disposed = true;
    };
  }, [settings]);

  const runTarget = useCallback(async (target: NetworkProxyTestTarget) => {
    setRunningTargets((current) => new Set(current).add(target));
    try {
      const result = await testNetworkProxy(
        target,
        settings,
        target === "custom" ? customTestUrl : undefined,
      );
      setResults((current) => ({ ...current, [target]: result }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [target]: {
          target,
          url: target === "custom" ? customTestUrl : "",
          success: false,
          statusCode: null,
          latencyMs: 0,
          route: resolution?.httpsProxy || resolution?.httpProxy ? "proxy" : "direct",
          proxyUrl: resolution?.httpsProxy ?? resolution?.httpProxy ?? null,
          errorKind: "configuration",
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setRunningTargets((current) => {
        const next = new Set(current);
        next.delete(target);
        return next;
      });
    }
  }, [customTestUrl, resolution, settings]);

  const runAll = useCallback(async () => {
    let index = 0;
    const targets = [...NETWORK_PROXY_TEST_TARGETS];
    const worker = async () => {
      while (index < targets.length) {
        const target = targets[index];
        index += 1;
        await runTarget(target);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  }, [runTarget]);

  const allRunning = NETWORK_PROXY_TEST_TARGETS.some((target) => runningTargets.has(target));

  return (
    <div className="mx-auto max-w-6xl">
      <SettingsPageHeader
        title={t("settings.network.title")}
        description={t("settings.network.description")}
      />

      <section className="app-glass-card rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-5">
        <div className="flex items-start gap-3">
          <GlobalOutlined className="mt-0.5 text-lg text-[var(--cs-primary)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--cs-text-primary)]">
              {t("settings.network.proxyMode")}
            </div>
            <Radio.Group
              className="mt-3 flex flex-col gap-3"
              value={networkProxyMode}
              onChange={(event) => setNetworkProxyMode(event.target.value)}
            >
              <Radio value="disabled">{t("settings.network.mode.disabled")}</Radio>
              <Radio value="system">{t("settings.network.mode.system")}</Radio>
              <Radio value="custom">{t("settings.network.mode.custom")}</Radio>
            </Radio.Group>

            {networkProxyMode === "custom" && (
              <div className="mt-4 max-w-2xl">
                <div className="mb-1.5 text-xs text-[var(--cs-text-secondary)]">
                  {t("settings.network.customProxyUrl")}
                </div>
                <Input
                  value={networkCustomProxyUrl}
                  placeholder="http://127.0.0.1:7897"
                  onChange={(event) => setNetworkCustomProxyUrl(event.target.value)}
                />
              </div>
            )}

            <div className="mt-4 max-w-2xl">
              <div className="mb-1.5 text-xs text-[var(--cs-text-secondary)]">
                {t("settings.network.noProxy")}
              </div>
              <Input
                value={networkNoProxy}
                placeholder="localhost,127.0.0.1,::1"
                onChange={(event) => setNetworkNoProxy(event.target.value)}
              />
              <div className="mt-1 text-xs text-[var(--cs-text-tertiary)]">
                {t("settings.network.noProxyHint")}
              </div>
            </div>
          </div>
        </div>

      </section>

      <section className="app-glass-card mt-5 rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--cs-text-primary)]">
              {t("settings.network.connectivityTitle")}
            </div>
            <div className="mt-1 text-xs text-[var(--cs-text-tertiary)]">
              {t("settings.network.connectivityHint")}
            </div>
          </div>
          <Button
            className="shrink-0"
            icon={<ReloadOutlined />}
            loading={allRunning}
            disabled={networkProxyMode === "custom" && !networkCustomProxyUrl.trim()}
            onClick={() => void runAll()}
          >
            {t("settings.network.testAll")}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 min-[680px]:grid-cols-2 min-[1100px]:grid-cols-3">
          {NETWORK_PROXY_TEST_TARGETS.map((target) => (
            <TestCard
              key={target}
              target={target}
              result={results[target]}
              running={runningTargets.has(target)}
              onTest={() => void runTarget(target)}
            />
          ))}
        </div>

        <div className="mt-4 rounded-lg border border-[var(--cs-border-sidebar)] p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={customTestUrl}
              placeholder={t("settings.network.customTestPlaceholder")}
              onChange={(event) => setCustomTestUrl(event.target.value)}
            />
            <Button
              loading={runningTargets.has("custom")}
              disabled={!customTestUrl.trim()}
              onClick={() => void runTarget("custom")}
            >
              {t("settings.network.test")}
            </Button>
          </div>
          {results.custom && (
            <div className="mt-2">
              <ResultSummary result={results.custom} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function TestCard({
  target,
  result,
  running,
  onTest,
}: {
  target: NetworkProxyTestTarget;
  result?: NetworkProxyTestResult;
  running: boolean;
  onTest: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-3 shadow-sm transition-all hover:border-[var(--cs-primary)] hover:shadow-md">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <NetworkTargetLogo target={target} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--cs-text-primary)]">
            {t(`settings.network.targets.${target}`)}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--cs-text-tertiary)]">
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  result
                    ? result.success
                      ? "bg-[var(--cs-success)]"
                      : "bg-[var(--cs-danger)]"
                    : "bg-[var(--cs-text-tertiary)]"
                }`}
                aria-hidden="true"
              />
              {result ? t(result.success ? "settings.network.reachable" : "settings.network.unreachable") : t("settings.network.notTested")}
            </span>
            {result && (
              <span className="truncate tabular-nums text-[var(--cs-text-secondary)]">
                {result.latencyMs} ms
              </span>
            )}
          </div>
          {result && !result.success && result.error && (
            <div className="mt-1 truncate text-xs text-[var(--cs-danger)]" title={result.error}>
              {result.error}
            </div>
          )}
        </div>
      </div>
      <Button
        className="shrink-0 group-hover:border-[var(--cs-primary)]"
        type="text"
        icon={<ReloadOutlined />}
        loading={running}
        title={t("settings.network.test")}
        aria-label={t("settings.network.test")}
        onClick={onTest}
      />
    </div>
  );
}

function NetworkTargetLogo({ target }: { target: NetworkProxyTestTarget }) {
  const containerClassName = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--cs-border-sidebar)] bg-[var(--cs-bg-hover)]";

  switch (target) {
    case "googleOAuth":
      return <div className={containerClassName}><GoogleLogo /></div>;
    case "github":
      return <div className={containerClassName}><GitHubLogo /></div>;
    case "openai":
      return <div className={containerClassName}><img className="h-6 w-6 object-contain" src="/agents/codex.svg" alt="" aria-hidden="true" /></div>;
    case "claude":
      return <div className={containerClassName}><img className="h-6 w-6 object-contain" src="/agents/claude.svg" alt="" aria-hidden="true" /></div>;
    case "gemini":
      return <div className={containerClassName}><GeminiLogo /></div>;
    case "glm":
      return <div className={containerClassName}><GlmLogo /></div>;
    case "qwen":
      return <div className={containerClassName}><QwenLogo /></div>;
    case "custom":
      return null;
  }
}

function GoogleLogo() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.42l-3.24-2.52c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.89A6 6 0 0 1 6.07 12c0-.66.12-1.3.32-1.89v-2.6H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.49l3.35-2.6Z" />
      <path fill="#EA4335" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.6C7.18 7.74 9.39 5.98 12 5.98Z" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg className="h-6 w-6 text-[var(--cs-text-primary)]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.21.7-3.89-1.36-3.89-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.26-1.28-5.26-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.93 10.93 0 0 1 5.75 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.28 5.68.42.36.79 1.06.79 2.14v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function GeminiLogo() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="network-gemini-gradient" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1C7DFF" />
          <stop offset=".48" stopColor="#8E75FF" />
          <stop offset="1" stopColor="#FF5EA0" />
        </linearGradient>
      </defs>
      <path d="M12 1.5c.42 5.83 4.67 10.08 10.5 10.5-5.83.42-10.08 4.67-10.5 10.5C11.58 16.67 7.33 12.42 1.5 12 7.33 11.58 11.58 7.33 12 1.5Z" fill="url(#network-gemini-gradient)" />
    </svg>
  );
}

function GlmLogo() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 30 30" aria-hidden="true">
      <rect x="1.5" y="1.5" width="27" height="27" rx="6" fill="#2D2D2D" />
      <path fill="#fff" d="M6.2 7.1h9.27l-2.33 3.32H6.2V7.1Zm10.66 0h7.44L13.14 22.9H5.7L16.86 7.1Zm-2.33 15.8 2.33-3.32h6.97v3.32h-9.3Z" />
    </svg>
  );
}

function QwenLogo() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 233 236" aria-hidden="true">
      <path fill="#082DFF" d="M187.25 36.08h-52.9c0-2.25-.58-4.5-1.75-6.52l-7.08-12.26a13.04 13.04 0 0 0-11.28-6.52h-14.16A13.04 13.04 0 0 0 88.79 17.3L67.11 54.86a13.04 13.04 0 0 0 0 13.02l7.08 12.27a13.04 13.04 0 0 0 11.28 6.51h101.78a13.04 13.04 0 0 0 11.29-6.51l7.08-12.27a13.04 13.04 0 0 0 0-13.02l-7.08-12.27a13.04 13.04 0 0 0-11.29-6.51ZM12.35 99.5l26.45 45.82a13 13 0 0 0-4.77 4.77l-7.08 12.26a13.04 13.04 0 0 0 0 13.03l7.08 12.27a13.04 13.04 0 0 0 11.28 6.51h43.37a13.04 13.04 0 0 0 11.29-6.51l7.08-12.27a13.04 13.04 0 0 0 0-13.03L56.16 74.21a13.04 13.04 0 0 0-11.29-6.52H30.71a13.04 13.04 0 0 0-11.28 6.52l-7.08 12.26a13.04 13.04 0 0 0 0 13.03Zm142.38 119.76 26.45-45.81a13 13 0 0 0 6.51 1.74h14.17a13.04 13.04 0 0 0 11.28-6.51l7.08-12.27a13.04 13.04 0 0 0 0-13.03l-21.68-37.56a13.04 13.04 0 0 0-11.29-6.51h-14.16a13.04 13.04 0 0 0-11.28 6.51l-50.89 88.15a13.04 13.04 0 0 0 0 13.03l7.08 12.26a13.04 13.04 0 0 0 11.28 6.52h14.16a13.04 13.04 0 0 0 11.29-6.52Z" />
    </svg>
  );
}

function ResultSummary({
  result,
  hideReachability = false,
}: {
  result: NetworkProxyTestResult;
  hideReachability?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--cs-text-tertiary)]">
      {!hideReachability && (
        <Tag
          className="!m-0"
          color={result.success ? "success" : "error"}
          icon={result.success ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
        >
          {t(result.success ? "settings.network.reachable" : "settings.network.unreachable")}
        </Tag>
      )}
      <span>{t(`settings.network.route.${result.route}`)}</span>
      {result.proxyUrl && <span>{result.proxyUrl}</span>}
      <span>{result.latencyMs} ms</span>
      {result.statusCode && <span>HTTP {result.statusCode}</span>}
      {result.error && <span className="break-all text-[var(--cs-danger)]">{result.error}</span>}
    </div>
  );
}
