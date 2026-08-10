"use client";

import { useEffect, useRef, useState } from "react";

type Language = "zh" | "en";

const DURATION = 7200;
const STEP_DURATION = DURATION / 4;

const copy = {
  zh: {
    skip: "跳到主要内容",
    nav: { features: "功能", workflow: "工作流", agents: "Agent", download: "下载即将开放" },
    switchLanguage: "Switch to English",
    release: "v1.8.10 · Windows 原生工作台",
    heroLineOne: "让 AI 编程",
    heroLineTwo: "顺畅流动。",
    heroDescription:
      "Termflow 是为 Windows 打造的本地优先 AI 编程工作台。把你已经安装的 Claude Code、Codex、Antigravity CLI 和 OpenCode，与项目、会话、终端、Git 和变更审阅放在一起。",
    watchDemo: "观看 7 秒演示",
    downloadPending: "Windows 下载即将开放",
    pendingHint: "GitHub 仓库创建后自动开放",
    demoEyebrow: "SEE THE FLOW · 07.2 SEC",
    demoTitle: "从打开项目，到审阅并提交。",
    demoDescription: "Agent 执行、终端输出、文件变更和 Git 状态，都在同一条可见的桌面流程里。",
    demoRegion: "Termflow 7.2 秒产品工作流演示",
    play: "播放演示",
    pause: "暂停演示",
    next: "下一步",
    demoSteps: ["打开项目", "启动 Agent", "审阅变更", "提交结果"],
    projectReady: "项目上下文已就位",
    agentRunning: "Codex 正在执行",
    reviewReady: "按回合审阅变更",
    commitReady: "检查点已通过",
    whyEyebrow: "WHY TERMFLOW",
    whyTitle: "少一点来回切换，多一点掌控。",
    whyDescription: "不是再增加一个窗口，而是把 AI 编程里分散的动作收进同一条原生工作流。",
    cards: {
      contextTitle: "上下文跟着项目走",
      contextText: "不同项目保留各自的窗口、会话与状态，重新打开后继续推进。",
      cliTitle: "使用你自己的 CLI",
      cliText: "Termflow 检测系统中已经安装的 Agent，不捆绑，也不替代它们。",
      reviewTitle: "先审阅，再提交",
      reviewText: "按回合和文件检查 Agent 带来的 Diff，需要时回到检查点。",
      gitTitle: "Git 始终在手边",
      gitText: "查看 Diff、暂存、提交、同步与切换分支，无需离开工作区。",
    },
    agentsEyebrow: "YOUR AGENTS",
    agentsTitle: "你常用的 Agent，照常运行。",
    agentsDescription:
      "Termflow 从系统 PATH 检测已安装的 CLI，并为它们整理项目、会话与状态。每个 Agent 仍需由你独立安装和配置。",
    workflowEyebrow: "ONE FLOW",
    workflowTitle: "从指令到提交，四步完成。",
    flowItems: [
      ["打开项目", "项目、终端、文件与会话上下文同时就位。"],
      ["启动 Agent", "选择已经安装的 CLI，在独立会话里推进任务。"],
      ["审阅变更", "按回合和文件查看 Diff，需要时回到检查点。"],
      ["提交结果", "确认后，在同一界面完成 Git 提交。"],
    ],
    platformEyebrow: "WINDOWS NATIVE",
    platformTitle: "专为 Windows 打造。",
    platformDescription:
      "基于 Tauri 2、Rust、React 19 和 TypeScript 构建。工作区以本地为中心；Agent CLI 和实验性语音服务是否联网，取决于各自配置。",
    platformTags: ["Windows 10 / 11", "Local-first", "MIT License", "简中 · 繁中 · EN · 日本語"],
    finalEyebrow: "READY FOR THE NEXT FLOW",
    finalTitle: "下一段 AI 编程工作流，从这里开始。",
    finalDescription: "Windows 安装包与 GitHub 仓库正在准备中。开放后，下载按钮会直接指向最新 Release。",
    replay: "再看一次演示",
    footer: "Windows 上的本地优先 AI 编程工作台",
  },
  en: {
    skip: "Skip to main content",
    nav: { features: "Features", workflow: "Workflow", agents: "Agents", download: "Download coming soon" },
    switchLanguage: "切换到中文",
    release: "v1.8.10 · Native for Windows",
    heroLineOne: "Keep AI coding",
    heroLineTwo: "in flow.",
    heroDescription:
      "Termflow is a local-first AI coding workspace for Windows. Bring your installed Claude Code, Codex, Antigravity CLI, and OpenCode together with projects, sessions, terminal, Git, and change review.",
    watchDemo: "Watch the 7-sec demo",
    downloadPending: "Windows download coming soon",
    pendingHint: "Unlocks when the GitHub repository is ready",
    demoEyebrow: "SEE THE FLOW · 07.2 SEC",
    demoTitle: "From opening a project to reviewing and committing.",
    demoDescription: "Agent runs, terminal output, file changes, and Git status stay visible in one desktop flow.",
    demoRegion: "Termflow product workflow shown in 7.2 seconds",
    play: "Play demo",
    pause: "Pause demo",
    next: "Next step",
    demoSteps: ["Open project", "Launch agent", "Review changes", "Commit result"],
    projectReady: "Project context is ready",
    agentRunning: "Codex is running",
    reviewReady: "Review changes by turn",
    commitReady: "Checkpoint passed",
    whyEyebrow: "WHY TERMFLOW",
    whyTitle: "Fewer context switches. More control.",
    whyDescription: "Not another window. One native flow for the moving parts of AI development.",
    cards: {
      contextTitle: "Context stays with the project",
      contextText: "Keep each project's windows, sessions, and state ready to resume.",
      cliTitle: "Bring your own CLI",
      cliText: "Termflow detects installed agents without bundling or replacing them.",
      reviewTitle: "Review before you commit",
      reviewText: "Inspect agent changes by turn and file, with checkpoints when you need to go back.",
      gitTitle: "Git stays close",
      gitText: "Review, stage, commit, sync, and switch branches without leaving the workspace.",
    },
    agentsEyebrow: "YOUR AGENTS",
    agentsTitle: "Your agents, their own way.",
    agentsDescription:
      "Termflow detects installed CLIs from your system PATH and organizes their projects, sessions, and states. Each agent remains independently installed and configured by you.",
    workflowEyebrow: "ONE FLOW",
    workflowTitle: "From prompt to commit in four steps.",
    flowItems: [
      ["Open a project", "Bring the project, terminal, files, and session context online together."],
      ["Launch an agent", "Choose an installed CLI and move the task forward in its own session."],
      ["Review changes", "Inspect diffs by turn and file, and return to a checkpoint when needed."],
      ["Commit the result", "Approve the changes and finish the Git commit in the same view."],
    ],
    platformEyebrow: "WINDOWS NATIVE",
    platformTitle: "Built for Windows.",
    platformDescription:
      "Built with Tauri 2, Rust, React 19, and TypeScript for Windows 10 and 11. The workspace is local-first; agent CLIs and experimental voice services may use the networks configured for them.",
    platformTags: ["Windows 10 / 11", "Local-first", "MIT License", "简中 · 繁中 · EN · 日本語"],
    finalEyebrow: "READY FOR THE NEXT FLOW",
    finalTitle: "Your next AI coding flow starts here.",
    finalDescription:
      "The Windows installer and GitHub repository are being prepared. Once available, download will point directly to the latest Release.",
    replay: "Replay the demo",
    footer: "A local-first AI coding workspace for Windows",
  },
} as const;

const agents = [
  { name: "Claude Code", icon: "/agents/claude.svg", tone: "violet" },
  { name: "Codex", icon: "/agents/codex.svg", tone: "lime" },
  { name: "Antigravity CLI", icon: "/agents/antigravity.svg", tone: "cyan" },
  { name: "OpenCode", icon: "/agents/opencode.svg", tone: "white" },
] as const;

function formatTime(milliseconds: number) {
  return `00:${(milliseconds / 1000).toFixed(1).padStart(4, "0")}`;
}

function PendingAction({ label, hint, className = "" }: { label: string; hint: string; className?: string }) {
  return (
    <span className={`action action-disabled ${className}`} role="link" aria-disabled="true" title={hint}>
      <span>{label}</span>
      <span aria-hidden="true">↗</span>
    </span>
  );
}

function SignalField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const colors = ["#f7f8ff", "#76e8ff", "#8f7cff", "#d7ff45"];
    let seed = 24781;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const rays = Array.from({ length: 72 }, () => ({
      angle: random() * Math.PI * 2,
      offset: random(),
      speed: 0.035 + random() * 0.09,
      length: 22 + random() * 92,
      width: 0.35 + random() * 1.1,
      color: colors[Math.floor(random() * colors.length)],
    }));

    let width = 0;
    let height = 0;
    let frame = 0;
    let reducedMotion = media.matches;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      const centerX = width * 0.5;
      const centerY = Math.min(height * 0.52, 560);
      const maxRadius = Math.hypot(width, height) * 0.78;
      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.min(width, 620));
      glow.addColorStop(0, "rgba(198, 218, 255, .2)");
      glow.addColorStop(0.12, "rgba(94, 84, 214, .12)");
      glow.addColorStop(0.55, "rgba(13, 15, 36, .04)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);
      context.lineCap = "round";

      for (const ray of rays) {
        const phase = reducedMotion ? ray.offset : (ray.offset + time * 0.001 * ray.speed) % 1;
        const eased = phase * phase;
        const radius = 18 + eased * maxRadius;
        const tail = Math.max(4, radius - ray.length * (0.2 + phase));
        const cosine = Math.cos(ray.angle);
        const sine = Math.sin(ray.angle);
        context.globalAlpha = Math.min(0.82, 0.08 + phase * 0.7) * (1 - phase * 0.38);
        context.strokeStyle = ray.color;
        context.lineWidth = ray.width;
        context.beginPath();
        context.moveTo(centerX + cosine * tail, centerY + sine * tail * 0.7);
        context.lineTo(centerX + cosine * radius, centerY + sine * radius * 0.7);
        context.stroke();
      }
      context.globalAlpha = 1;
    };

    const loop = (time: number) => {
      draw(time);
      frame = window.requestAnimationFrame(loop);
    };

    const syncMotion = () => {
      reducedMotion = media.matches;
      window.cancelAnimationFrame(frame);
      if (reducedMotion) draw(1200);
      else frame = window.requestAnimationFrame(loop);
    };

    resize();
    syncMotion();
    window.addEventListener("resize", resize);
    media.addEventListener("change", syncMotion);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      media.removeEventListener("change", syncMotion);
    };
  }, []);

  return <canvas ref={canvasRef} className="signal-field" aria-hidden="true" />;
}

function ProductDemo({ language }: { language: Language }) {
  const t = copy[language];
  const regionRef = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef(0);
  const originRef = useRef(0);
  const stepRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const timeBucketRef = useRef(-1);
  const [activeStep, setActiveStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inView, setInView] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const paint = (value: number) => {
    const normalized = ((value % DURATION) + DURATION) % DURATION;
    elapsedRef.current = normalized;
    progressRef.current?.style.setProperty("transform", `scaleX(${normalized / DURATION})`);
    const bucket = Math.floor(normalized / 100);
    if (bucket !== timeBucketRef.current) {
      timeBucketRef.current = bucket;
      if (timeRef.current) timeRef.current.textContent = formatTime(normalized);
    }
    const nextStep = Math.min(3, Math.floor(normalized / STEP_DURATION));
    if (nextStep !== stepRef.current) {
      stepRef.current = nextStep;
      setActiveStep(nextStep);
    }
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReducedMotion(media.matches);
      setPlaying(!media.matches);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const node = regionRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (entry.isIntersecting) originRef.current = performance.now() - elapsedRef.current;
      },
      { threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || reducedMotion || !inView) return;
    originRef.current = performance.now() - elapsedRef.current;
    const tick = (now: number) => {
      if (!document.hidden) paint(now - originRef.current);
      else originRef.current = now - elapsedRef.current;
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [inView, playing, reducedMotion]);

  const seek = (index: number, announce = true) => {
    const next = index * STEP_DURATION + 16;
    stepRef.current = index;
    setActiveStep(index);
    paint(next);
    originRef.current = performance.now() - next;
    if (announce) setAnnouncement(t.demoSteps[index]);
  };

  const togglePlayback = () => {
    if (reducedMotion) {
      seek((activeStep + 1) % 4);
      return;
    }
    if (!playing) originRef.current = performance.now() - elapsedRef.current;
    setPlaying((current) => !current);
  };

  return (
    <section
      ref={regionRef}
      id="demo"
      className={`product-stage ${inView ? "is-in-view" : ""}`}
      role="region"
      aria-labelledby="demo-title"
    >
      <div className="demo-copy" data-reveal>
        <p className="eyebrow">{t.demoEyebrow}</p>
        <h2 id="demo-title">{t.demoTitle}</h2>
        <p>{t.demoDescription}</p>
      </div>

      <div className="demo-aura" aria-hidden="true" />
      <div className="demo-window" aria-label={t.demoRegion}>
        <header className="window-bar">
          <div className="window-brand"><span className="mini-mark">T</span><b>Termflow</b></div>
          <div className="window-project">D:\Projects\Termflow <span>feat/agent-flow</span></div>
          <button
            type="button"
            className="window-play"
            onClick={togglePlayback}
            aria-label={reducedMotion ? t.next : playing ? t.pause : t.play}
            aria-pressed={playing}
          >
            <span aria-hidden="true">{reducedMotion ? "→" : playing ? "Ⅱ" : "▶"}</span>
          </button>
          <div className="window-actions" aria-hidden="true"><i>—</i><i>□</i><i>×</i></div>
        </header>

        <div className="workspace-shell">
          <nav className="app-rail" aria-label="Termflow">
            <span className="app-rail-logo">T</span>
            <button className="is-active" type="button" aria-label="Projects">⌘</button>
            <button type="button" aria-label="Sessions">◫</button>
            <button type="button" aria-label="Git">⑂</button>
            <button type="button" aria-label="Settings">⚙</button>
          </nav>

          <aside className="session-panel">
            <div className="panel-label"><span>WORKSPACE</span><b>+</b></div>
            <div className="project-row is-active"><span className="project-orb" /><b>Termflow</b><small>main · local</small></div>
            <div className="panel-label session-label"><span>AGENT SESSIONS</span><b>04</b></div>
            {agents.map((agent, index) => (
              <div key={agent.name} className={`session-row ${index === 1 ? "is-running" : ""}`}>
                <img src={agent.icon} alt="" width="18" height="18" />
                <span><b>{agent.name}</b><small>{index === 1 ? "RUNNING · 08s" : "READY"}</small></span>
                <i aria-hidden="true" />
              </div>
            ))}
          </aside>

          <main className="workbench">
            <div className="workbench-tabs"><span className="is-active">Codex · session-04</span><span>Terminal</span><b>+</b></div>
            <div className="terminal-head"><span>TERMINAL / CODEX</span><b className={activeStep > 0 ? "is-live" : ""}>{activeStep > 0 ? "RUNNING" : "READY"}</b></div>
            <div className="terminal-body">
              <p className="terminal-command"><span>❯</span> add attention states to the session list <i /></p>
              <div className={`terminal-line is-visible`}><time>00:00</time><b>SYS</b><span>{t.projectReady}</span><em>OK</em></div>
              <div className={`terminal-line ${activeStep >= 1 ? "is-visible" : ""}`}><time>00:02</time><b>CODEX</b><span>{t.agentRunning}</span><em>LIVE</em></div>
              <div className={`terminal-line ${activeStep >= 1 ? "is-visible" : ""}`}><time>00:03</time><b>EDIT</b><span>SidebarSessionsPanel.tsx</span><em>+42</em></div>
              <div className={`terminal-line ${activeStep >= 2 ? "is-visible" : ""}`}><time>00:05</time><b>DIFF</b><span>{t.reviewReady}</span><em>04</em></div>
              <div className={`terminal-line ${activeStep >= 3 ? "is-visible" : ""}`}><time>00:07</time><b>TEST</b><span>42 tests passed</span><em>PASS</em></div>
              <div className="terminal-footer"><span>LOCAL CONTEXT</span><i /><span>CONPTY</span><i /><span>UTF-8</span></div>
            </div>

            <aside className={`diff-drawer ${activeStep >= 2 ? "is-open" : ""}`} aria-hidden={activeStep < 2}>
              <div className="diff-head"><span>CHANGE REVIEW</span><b>+42 <i>−8</i></b></div>
              <div className="diff-file">src/components/SidebarSessionsPanel.tsx</div>
              <pre><code>
                <span className="context">18  export function SessionRow() {'{'}</span>
                <span className="remove">19 − return &lt;LegacyState /&gt;</span>
                <span className="add">19 + const attention = useAttention()</span>
                <span className="add">20 + return &lt;SessionState value={'{'}attention{'}'} /&gt;</span>
                <span className="context">21  {'}'}</span>
                <span className="add">22 + export const reviewMode = &quot;checkpoint&quot;</span>
              </code></pre>
              <div className="diff-actions"><button type="button">Undo</button><button type="button">Keep change</button></div>
            </aside>

            <div className={`commit-toast ${activeStep === 3 ? "is-visible" : ""}`} aria-hidden={activeStep !== 3}>
              <span className="commit-check">✓</span>
              <div><small>CHECKPOINT / COMMIT</small><b>{t.commitReady}</b><code>8f2ac71 · feat: add agent attention states</code></div>
            </div>
          </main>
        </div>

        <footer className="demo-timeline">
          <button
            type="button"
            className="timeline-toggle"
            onClick={togglePlayback}
            aria-label={reducedMotion ? t.next : playing ? t.pause : t.play}
            aria-pressed={playing}
          >
            <span aria-hidden="true">{reducedMotion ? "→" : playing ? "Ⅱ" : "▶"}</span>
          </button>
          <div className="timeline-track"><span ref={progressRef} /></div>
          <div className="timeline-steps" role="group" aria-label={t.demoRegion}>
            {t.demoSteps.map((label, index) => (
              <button key={label} type="button" className={activeStep === index ? "is-active" : ""} onClick={() => seek(index)}>
                <small>0{index + 1}</small><span>{label}</span>
              </button>
            ))}
          </div>
          <span className="timeline-clock"><span ref={timeRef}>00:00.0</span> / 00:07.2</span>
        </footer>
      </div>
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </section>
  );
}

function useReveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.16 },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
}

export default function Home() {
  const [language, setLanguage] = useState<Language>("zh");
  useReveal();
  const t = copy[language];
  const repository = (process.env.NEXT_PUBLIC_GITHUB_REPOSITORY ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^\/+|\/+$/g, "");
  const githubUrl = repository ? `https://github.com/${repository}` : "";
  const releaseUrl = githubUrl ? `${githubUrl}/releases/latest` : "";

  useEffect(() => {
    const stored = window.localStorage.getItem("termflow-language");
    if (stored === "zh" || stored === "en") setLanguage(stored);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("termflow-language", language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  return (
    <>
      <a className="skip-link" href="#main">{t.skip}</a>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Termflow home">
          <img src="/termflow-logo.svg" alt="" width="30" height="30" />
          <strong>Termflow</strong>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#features">{t.nav.features}</a>
          <a href="#workflow">{t.nav.workflow}</a>
          <a href="#agents">{t.nav.agents}</a>
        </nav>
        <div className="header-actions">
          <button type="button" className="language-toggle" onClick={() => setLanguage(language === "zh" ? "en" : "zh")} aria-label={t.switchLanguage}>
            {language === "zh" ? "EN" : "中文"}
          </button>
          {releaseUrl ? <a className="header-download" href={releaseUrl}>{t.nav.download}</a> : <span className="header-download is-disabled">{t.nav.download}</span>}
        </div>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <SignalField />
          <div className="hero-horizon" aria-hidden="true" />
          <div className="hero-copy">
            <p className="release-pill"><span>NEW</span>{t.release}</p>
            <h1><span>{t.heroLineOne}</span><em>{t.heroLineTwo}</em></h1>
            <p className="hero-description">{t.heroDescription}</p>
            <div className="hero-actions">
              <a className="action action-primary" href="#demo"><span>{t.watchDemo}</span><span aria-hidden="true">↓</span></a>
              {releaseUrl ? (
                <a className="action action-secondary" href={releaseUrl}><span>{t.downloadPending}</span><span aria-hidden="true">↗</span></a>
              ) : (
                <PendingAction label={t.downloadPending} hint={t.pendingHint} className="action-secondary" />
              )}
            </div>
          </div>
          <ProductDemo language={language} />
        </section>

        <section className="why-section section-shell" id="features">
          <div className="section-intro" data-reveal>
            <p className="eyebrow">{t.whyEyebrow}</p>
            <h2>{t.whyTitle}</h2>
            <p>{t.whyDescription}</p>
          </div>
          <div className="bento-grid">
            <article className="bento-card context-card" data-reveal>
              <span className="card-index">01 / CONTEXT</span>
              <div className="context-visual" aria-hidden="true">
                <div className="context-project is-active"><i /><span><b>Termflow</b><small>4 sessions · active</small></span><em>⌘</em></div>
                <div className="context-project"><i /><span><b>Client portal</b><small>2 sessions · paused</small></span><em>02</em></div>
                <div className="context-project"><i /><span><b>API service</b><small>1 session · ready</small></span><em>01</em></div>
              </div>
              <h3>{t.cards.contextTitle}</h3><p>{t.cards.contextText}</p>
            </article>

            <article className="bento-card cli-card" data-reveal>
              <span className="card-index">02 / BYO CLI</span>
              <div className="agent-orbit" aria-hidden="true">
                {agents.map((agent) => <span key={agent.name} className={agent.tone}><img src={agent.icon} alt="" /></span>)}
                <b>PATH</b>
              </div>
              <h3>{t.cards.cliTitle}</h3><p>{t.cards.cliText}</p>
            </article>

            <article className="bento-card review-card" data-reveal>
              <span className="card-index">03 / REVIEW</span>
              <div className="review-visual" aria-hidden="true">
                <span>SidebarSessionsPanel.tsx</span>
                <code><i>− legacy state</i><b>+ attention state</b><b>+ checkpoint review</b></code>
                <em>KEEP CHANGE</em>
              </div>
              <h3>{t.cards.reviewTitle}</h3><p>{t.cards.reviewText}</p>
            </article>

            <article className="bento-card git-card" data-reveal>
              <span className="card-index">04 / GIT</span>
              <div className="git-visual" aria-hidden="true"><span>✓</span><div><small>CHECKPOINT PASSED</small><b>feat/agent-flow</b><code>8f2ac71</code></div></div>
              <h3>{t.cards.gitTitle}</h3><p>{t.cards.gitText}</p>
            </article>
          </div>
        </section>

        <section className="agents-section" id="agents">
          <div className="section-shell agent-copy" data-reveal>
            <p className="eyebrow">{t.agentsEyebrow}</p>
            <h2>{t.agentsTitle}</h2>
            <p>{t.agentsDescription}</p>
          </div>
          <div className="agent-stream" aria-label="Supported agents">
            {[...agents, ...agents].map((agent, index) => (
              <article key={`${agent.name}-${index}`}>
                <img src={agent.icon} alt="" width="34" height="34" />
                <strong>{agent.name}</strong><span>CLI · DETECTED</span>
              </article>
            ))}
          </div>
        </section>

        <section className="workflow-section section-shell" id="workflow">
          <div className="workflow-heading" data-reveal>
            <p className="eyebrow">{t.workflowEyebrow}</p>
            <h2>{t.workflowTitle}</h2>
          </div>
          <ol className="flow-list">
            {t.flowItems.map(([title, description], index) => (
              <li key={title} data-reveal>
                <span>0{index + 1}</span>
                <div className="flow-line"><i /></div>
                <h3>{title}</h3><p>{description}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="platform-section section-shell">
          <div className="platform-copy" data-reveal>
            <p className="eyebrow">{t.platformEyebrow}</p>
            <h2>{t.platformTitle}</h2>
            <p>{t.platformDescription}</p>
            <div className="platform-tags">{t.platformTags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          </div>
          <div className="platform-orb" aria-hidden="true" data-reveal>
            <span className="orb-ring ring-one" /><span className="orb-ring ring-two" /><span className="orb-ring ring-three" />
            <b>TF</b><small>LOCAL<br />WORKSPACE</small>
          </div>
        </section>

        <section className="final-section">
          <div className="final-glow" aria-hidden="true" />
          <div className="section-shell final-content" data-reveal>
            <p className="eyebrow">{t.finalEyebrow}</p>
            <h2>{t.finalTitle}</h2>
            <p>{t.finalDescription}</p>
            <div className="hero-actions final-actions">
              <a className="action action-primary" href="#demo"><span>{t.replay}</span><span aria-hidden="true">↑</span></a>
              {githubUrl ? <a className="action action-secondary" href={githubUrl}><span>GitHub</span><span aria-hidden="true">↗</span></a> : <PendingAction label={t.downloadPending} hint={t.pendingHint} className="action-secondary" />}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer section-shell">
        <a className="brand" href="#top"><img src="/termflow-logo.svg" alt="" width="28" height="28" /><strong>Termflow</strong></a>
        <p>{t.footer}</p><span>© 2026 Termflow · MIT License</span>
      </footer>
    </>
  );
}
