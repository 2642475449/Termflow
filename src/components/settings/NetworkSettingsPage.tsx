import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlibabaOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  GithubFilled,
  GlobalOutlined,
  GoogleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Radio, Spin, Tag } from "antd";
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
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
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
    setResolving(true);
    resolveNetworkProxySettings(settings)
      .then((next) => {
        if (disposed) return;
        setResolution(next);
        setResolutionError(null);
      })
      .catch((error) => {
        if (disposed) return;
        setResolution(null);
        setResolutionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setResolving(false);
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

  const resolvedUrl = resolution?.httpsProxy ?? resolution?.httpProxy ?? null;
  const allRunning = NETWORK_PROXY_TEST_TARGETS.some((target) => runningTargets.has(target));

  return (
    <div className="mx-auto max-w-6xl">
      <SettingsPageHeader
        title={t("settings.network.title")}
        description={t("settings.network.description")}
        actions={(
          <Button
            icon={<ReloadOutlined />}
            loading={allRunning}
            disabled={networkProxyMode === "custom" && !networkCustomProxyUrl.trim()}
            onClick={() => void runAll()}
          >
            {t("settings.network.testAll")}
          </Button>
        )}
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

        <div className="mt-5 rounded-lg border border-[var(--cs-border-sidebar)] bg-[var(--cs-bg-hover)] px-4 py-3">
          {resolving ? (
            <div className="flex items-center gap-2 text-sm text-[var(--cs-text-secondary)]">
              <Spin size="small" /> {t("settings.network.resolving")}
            </div>
          ) : resolutionError ? (
            <Alert type="error" showIcon message={resolutionError} />
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-[var(--cs-text-primary)]">
                {resolvedUrl
                  ? t("settings.network.resolvedProxy", { proxy: resolvedUrl })
                  : t("settings.network.resolvedDirect")}
              </div>
              <div className="text-xs text-[var(--cs-text-tertiary)]">
                {t("settings.network.source", {
                  source: t(`settings.network.sources.${resolution?.source ?? "unknown"}`),
                })}
              </div>
              {resolution?.warning && (
                <Alert
                  className="mt-2"
                  type="warning"
                  showIcon
                  message={t(`settings.network.warnings.${resolution.warning}`)}
                />
              )}
            </div>
          )}
        </div>

        <Alert
          className="mt-4"
          type="info"
          showIcon
          message={t("settings.network.newTerminalHint")}
        />
      </section>

      <section className="app-glass-card mt-5 rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-5">
        <div className="mb-4">
          <div className="text-sm font-medium text-[var(--cs-text-primary)]">
            {t("settings.network.connectivityTitle")}
          </div>
          <div className="mt-1 text-xs text-[var(--cs-text-tertiary)]">
            {t("settings.network.connectivityHint")}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 min-[620px]:grid-cols-2 min-[940px]:grid-cols-3 min-[1240px]:grid-cols-4">
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
    <div className="flex min-w-0 flex-col rounded-xl border border-[var(--cs-border-sidebar)] bg-[var(--cs-bg-hover)] p-3 transition-colors hover:border-[var(--cs-primary)]">
      <div className="flex min-w-0 items-center gap-3">
        <NetworkTargetLogo target={target} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--cs-text-primary)]">
            {t(`settings.network.targets.${target}`)}
          </div>
          <div className="mt-0.5 text-xs text-[var(--cs-text-tertiary)]">
            {result ? t(result.success ? "settings.network.reachable" : "settings.network.unreachable") : t("settings.network.notTested")}
          </div>
        </div>
      </div>

      <div className="mt-3 min-h-12">
        {result && <ResultSummary result={result} hideReachability />}
      </div>

      <Button className="mt-3 w-full" size="small" loading={running} onClick={onTest}>
        {t("settings.network.test")}
      </Button>
    </div>
  );
}

function NetworkTargetLogo({ target }: { target: NetworkProxyTestTarget }) {
  const containerClassName = "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--cs-border-sidebar)] bg-[var(--cs-bg-card)]";
  const iconClassName = "text-xl text-[var(--cs-primary)]";

  switch (target) {
    case "googleOAuth":
      return <div className={containerClassName}><GoogleOutlined className={iconClassName} /></div>;
    case "github":
      return <div className={containerClassName}><GithubFilled className={iconClassName} /></div>;
    case "openai":
      return <div className={containerClassName}><img className="h-6 w-6 object-contain" src="/agents/codex.svg" alt="" aria-hidden="true" /></div>;
    case "claude":
      return <div className={containerClassName}><img className="h-6 w-6 object-contain" src="/agents/claude.svg" alt="" aria-hidden="true" /></div>;
    case "gemini":
      return <div className={containerClassName}><GeminiLogo /></div>;
    case "glm":
      return <div className={containerClassName}><span className="text-base font-bold text-[var(--cs-primary)]" aria-hidden="true">智</span></div>;
    case "qwen":
      return <div className={containerClassName}><AlibabaOutlined className={iconClassName} /></div>;
    case "custom":
      return null;
  }
}

function GeminiLogo() {
  return (
    <svg className="h-6 w-6 text-[var(--cs-primary)]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.5C13.5 8.5 15.5 10.5 21.5 12C15.5 13.5 13.5 15.5 12 21.5C10.5 15.5 8.5 13.5 2.5 12C8.5 10.5 10.5 8.5 12 2.5Z" fill="currentColor" />
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
