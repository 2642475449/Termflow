// 开发环境通过已有 Vite 通道收集未捕获错误，不向外部服务发送数据。
if (import.meta.env.DEV && import.meta.hot) {
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    import.meta.hot?.send("termflow:runtime-error", { message, stack });
    if (!window.location.search && !document.querySelector(".app-shell")) {
      const existing = document.querySelector(".app-dev-runtime-error");
      const display = existing ?? document.createElement("pre");
      display.className = "app-dev-runtime-error";
      display.setAttribute("role", "alert");
      display.textContent = stack ?? message;
      if (!existing) document.body.append(display);
    }
  };
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
}
