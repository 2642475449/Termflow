import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Git 刷新控制器配置
 */
interface GitRefreshControllerConfig {
  /** 防抖延迟（毫秒），默认 1000 */
  debounceDelay?: number;
  /** 冷却时间（毫秒），默认 5000 */
  cooldownDelay?: number;
  /** 轮询间隔（毫秒），默认 30000（比原来的 15 秒更保守） */
  pollingInterval?: number;
}

/**
 * Git 刷新控制器返回值
 */
interface GitRefreshControllerReturn {
  /** 请求刷新（带防抖） */
  requestRefresh: () => void;
  /** 立即刷新（跳过防抖，用于手动刷新按钮） */
  refreshNow: () => void;
  /** 标记 git 操作开始 */
  markOperationStart: () => void;
  /** 标记 git 操作结束 */
  markOperationEnd: () => void;
  /** 是否有操作正在执行 */
  isOperating: boolean;
}

/**
 * Git 刷新控制器
 *
 * 参考 VS Code 的刷新策略：
 * 1. 防抖：文件变化后等待 N 秒，连续变化时重新计时
 * 2. 冷却：刷新完成后强制等待 M 秒，防止过于频繁
 * 3. 操作保护：有 git 操作在执行时跳过刷新
 * 4. 失焦优化：窗口失焦时暂停轮询，聚焦时触发刷新
 */
export function useGitRefreshController(
  onRefresh: () => Promise<void>,
  config: GitRefreshControllerConfig = {}
): GitRefreshControllerReturn {
  const {
    debounceDelay = 1000,
    cooldownDelay = 5000,
    pollingInterval = 30000,
  } = config;

  const debounceTimerRef = useRef<number | null>(null);
  const cooldownTimerRef = useRef<number | null>(null);
  const pollingTimerRef = useRef<number | null>(null);
  const isCoolingDownRef = useRef(false);
  const isOperatingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const isMountedRef = useRef(true);
  const executeRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [isOperating, setIsOperating] = useState(false);

  // 清理定时器
  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearCooldownTimer = useCallback(() => {
    if (cooldownTimerRef.current !== null) {
      window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  const clearPollingTimer = useCallback(() => {
    if (pollingTimerRef.current !== null) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  // 执行刷新（带冷却保护）
  const executeRefresh = useCallback(async () => {
    // 守卫条件：冷却中、有操作在执行、组件已卸载
    if (isCoolingDownRef.current || isOperatingRef.current || !isMountedRef.current) {
      if (isMountedRef.current) pendingRefreshRef.current = true;
      return;
    }

    pendingRefreshRef.current = false;
    try {
      await onRefresh();
    } catch (error) {
      console.error("[GitRefreshController] Refresh failed:", error);
    }

    // 开始冷却期
    isCoolingDownRef.current = true;
    clearCooldownTimer();
    cooldownTimerRef.current = window.setTimeout(() => {
      isCoolingDownRef.current = false;
      cooldownTimerRef.current = null;
      if (pendingRefreshRef.current && !isOperatingRef.current && isMountedRef.current) {
        void executeRefreshRef.current();
      }
    }, cooldownDelay);
  }, [onRefresh, cooldownDelay, clearCooldownTimer]);
  executeRefreshRef.current = executeRefresh;

  // 请求刷新（带防抖）
  const requestRefresh = useCallback(() => {
    clearDebounceTimer();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void executeRefresh();
    }, debounceDelay);
  }, [debounceDelay, clearDebounceTimer, executeRefresh]);

  // 立即刷新（跳过防抖，用于手动刷新按钮）
  const refreshNow = useCallback(() => {
    clearDebounceTimer();
    void executeRefresh();
  }, [clearDebounceTimer, executeRefresh]);

  // 标记 git 操作开始
  const markOperationStart = useCallback(() => {
    isOperatingRef.current = true;
    setIsOperating(true);
    // 操作期间取消待执行的刷新
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  // 标记 git 操作结束
  const markOperationEnd = useCallback(() => {
    isOperatingRef.current = false;
    setIsOperating(false);
    // 操作结束后请求一次刷新
    requestRefresh();
  }, [requestRefresh]);

  // 初始化：挂载时执行一次刷新 + 设置轮询
  useEffect(() => {
    isMountedRef.current = true;

    // 首次刷新
    void executeRefresh();

    // 设置轮询（比原来的 15 秒更保守）
    pollingTimerRef.current = window.setInterval(() => {
      void executeRefresh();
    }, pollingInterval);

    return () => {
      isMountedRef.current = false;
      pendingRefreshRef.current = false;
      clearDebounceTimer();
      clearCooldownTimer();
      clearPollingTimer();
    };
  }, [executeRefresh, pollingInterval, clearDebounceTimer, clearCooldownTimer, clearPollingTimer]);

  // 失焦优化：失焦时暂停轮询，聚焦时触发刷新
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // 页面变为可见时，重置冷却并触发刷新
        isCoolingDownRef.current = false;
        clearCooldownTimer();
        void executeRefresh();
      }
    };

    const handleWindowFocus = () => {
      // 窗口获得焦点时，重置冷却并触发刷新
      isCoolingDownRef.current = false;
      clearCooldownTimer();
      void executeRefresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [executeRefresh, clearCooldownTimer]);

  return {
    requestRefresh,
    refreshNow,
    markOperationStart,
    markOperationEnd,
    isOperating,
  };
}
