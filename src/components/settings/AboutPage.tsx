import { useState, type FC } from "react";
import {
  AppstoreOutlined,
  CopyOutlined,
  GithubOutlined,
  GlobalOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  FileProtectOutlined,
  TeamOutlined,
  ArrowRightOutlined,
} from "@ant-design/icons";
import { Button, Modal, Space, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import packageJson from "../../../package.json";
import { AGENT_DEFINITIONS, AI_AGENT_ORDER } from "@/lib/agents";
import { openExternalUrl } from "@/lib/api";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingRow } from "@/components/settings/SettingRow";
import { AboutFlowBackdrop } from "./AboutFlowBackdrop";

const ABOUT_LINKS: Record<"website" | "github" | "license", string | null> = {
  website: null,
  github: "https://github.com/2642475449/Termflow",
  license: "https://github.com/2642475449/Termflow/blob/main/LICENSE",
};

const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 降蓝

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

interface ThirdPartyNotice {
  name: string;
  license: string;
  descriptionKey: string;
  url: string;
}

const THIRD_PARTY_LIBRARIES: ThirdPartyNotice[] = [
  {
    name: "Tauri",
    license: "Apache-2.0 / MIT",
    descriptionKey: "settings.about.thirdPartyTauri",
    url: "https://tauri.app",
  },
  {
    name: "React",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyReact",
    url: "https://react.dev",
  },
  {
    name: "Monaco Editor",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyMonaco",
    url: "https://microsoft.github.io/monaco-editor",
  },
  {
    name: "xterm.js",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyXterm",
    url: "https://xtermjs.org",
  },
  {
    name: "Ant Design",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyAntd",
    url: "https://ant.design",
  },
  {
    name: "portable-pty",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyPty",
    url: "https://github.com/wez/wezterm",
  },
  {
    name: "git2-rs (libgit2)",
    license: "MIT / Apache-2.0",
    descriptionKey: "settings.about.thirdPartyGit2",
    url: "https://github.com/rust-lang/git2-rs",
  },
  {
    name: "rusqlite",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyRusqlite",
    url: "https://github.com/rusqlite/rusqlite",
  },
  {
    name: "Zustand",
    license: "MIT",
    descriptionKey: "settings.about.thirdPartyZustand",
    url: "https://github.com/pmndrs/zustand",
  },
];

export interface AboutPageProps {
  onNavigate?: (page: string) => void;
}

export const AboutPage: FC<AboutPageProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [licenseModalOpen, setLicenseModalOpen] = useState(false);
  const [thirdPartyModalOpen, setThirdPartyModalOpen] = useState(false);

  const supportedAgents = AI_AGENT_ORDER.map((id) => ({
    id,
    name: AGENT_DEFINITIONS[id].displayName,
  }));

  const productHighlights = [
    {
      key: "agent-orchestration",
      icon: <AppstoreOutlined />,
      title: t("settings.about.agentOrchestration"),
      desc: t("settings.about.agentOrchestrationDesc"),
    },
    {
      key: "context-continuity",
      icon: <ReloadOutlined />,
      title: t("settings.about.contextContinuity"),
      desc: t("settings.about.contextContinuityDesc"),
    },
    {
      key: "local-control",
      icon: <SafetyCertificateOutlined />,
      title: t("settings.about.localControl"),
      desc: t("settings.about.localControlDesc"),
    },
  ];

  const openAboutLink = (url: string | null) => {
    if (url) void openExternalUrl(url).catch(() => {});
  };

  const handleCopyDiagnostics = async () => {
    const diagnostics = [
      `Application: Termflow`,
      `Version: v${packageJson.version}`,
      `App ID: com.termflow.desktop`,
      `Platform: ${navigator.userAgent}`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(diagnostics);
      message.success(t("settings.about.diagnosticsCopied"));
    } catch {
      message.error(t("settings.about.copyFailed"));
    }
  };

  const handleCopyLicense = async () => {
    try {
      await navigator.clipboard.writeText(MIT_LICENSE_TEXT);
      message.success(t("common.copied"));
    } catch {
      message.error(t("settings.about.copyFailed"));
    }
  };

  return (
    <div className="app-about-settings">
      {/* Hero Header */}
      <div className="app-about-hero app-flow-surface app-glass-card relative overflow-hidden rounded-2xl">
        <AboutFlowBackdrop />
        <div className="app-about-hero-glow-primary pointer-events-none absolute -right-16 -top-28 h-64 w-64 rounded-full blur-3xl" />
        <div className="app-about-hero-glow-secondary pointer-events-none absolute -bottom-24 left-1/3 h-48 w-48 rounded-full blur-3xl" />

        <div className="app-about-hero-content relative flex flex-col gap-6 px-6 py-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <img
              src="/logo.png"
              alt="Termflow"
              className="h-16 w-16 shrink-0 object-contain"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="app-about-hero-title m-0 text-2xl font-semibold tracking-tight">
                  Termflow
                </h1>
                <Tag className="app-about-hero-version !m-0 rounded-full !px-2.5">
                  v{packageJson.version}
                </Tag>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              icon={<GlobalOutlined />}
              disabled={!ABOUT_LINKS.website}
              onClick={() => openAboutLink(ABOUT_LINKS.website)}
            >
              {t("settings.about.officialWebsite")}
            </Button>
            <Button
              icon={<GithubOutlined />}
              disabled={!ABOUT_LINKS.github}
              onClick={() => openAboutLink(ABOUT_LINKS.github)}
            >
              GitHub
            </Button>
            {!ABOUT_LINKS.website && !ABOUT_LINKS.github && (
              <Tag className="!m-0 flex items-center rounded-full !px-2.5">
                {t("settings.about.comingSoon")}
              </Tag>
            )}
          </div>
        </div>

        <div className="app-about-hero-footer relative flex flex-wrap items-center gap-2 border-t px-6 py-4">
          <span className="app-about-hero-agents-label mr-1 text-xs font-medium">
            {t("settings.about.supportedAgents")}
          </span>
          {supportedAgents.map((agent) => (
            <div
              key={agent.id}
              className="app-about-hero-agent flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
            >
              <AgentIcon agentId={agent.id} size={15} />
              <span className="text-xs font-medium">{agent.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Positioning / Mission */}
      <SettingsSection title={t("settings.menu.about")}>
        <p className="m-0 text-sm leading-7 text-[var(--cs-text-secondary)]">
          {t("settings.about.description")}
        </p>
      </SettingsSection>

      {/* Capabilities */}
      <SettingsSection title={t("settings.about.capabilities")}>
        <div className="app-about-highlights">
          {productHighlights.map((item) => (
            <div key={item.key} className="min-w-0">
              <h3 className="m-0 flex items-center gap-2 text-sm font-medium text-[var(--cs-text-primary)]">
                <span className="text-[var(--cs-primary)]" aria-hidden="true">
                  {item.icon}
                </span>
                {item.title}
              </h3>
              <p className="mb-0 mt-2 text-xs leading-6 text-[var(--cs-text-secondary)]">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </SettingsSection>

      {/* License & Legal Agreements (重点：协议与合规) */}
      <SettingsSection
        title={t("settings.about.licenseAndLegal")}
        description={t("settings.about.licenseAndLegalDesc")}
      >
        <SettingRow
          label={t("settings.about.license")}
          description={t("settings.about.licenseDesc")}
        >
          <Space>
            <Button onClick={() => setLicenseModalOpen(true)}>
              {t("settings.about.viewLicense")}
            </Button>
            {ABOUT_LINKS.license && (
              <Button
                icon={<GithubOutlined />}
                onClick={() => openAboutLink(ABOUT_LINKS.license)}
              >
                GitHub
              </Button>
            )}
          </Space>
        </SettingRow>

        <SettingRow
          label={t("settings.about.privacyPolicy")}
          description={t("settings.about.privacyPolicyDesc")}
        >
          {onNavigate ? (
            <Button
              icon={<ArrowRightOutlined />}
              onClick={() => onNavigate("dataPrivacy")}
            >
              {t("settings.about.managePrivacy")}
            </Button>
          ) : (
            <Tag icon={<LockOutlined />} color="processing">
              {t("settings.about.localFirstBadge")}
            </Tag>
          )}
        </SettingRow>

        <SettingRow
          label={t("settings.about.thirdPartyNotices")}
          description={t("settings.about.thirdPartyNoticesDesc")}
        >
          <Button
            icon={<TeamOutlined />}
            onClick={() => setThirdPartyModalOpen(true)}
          >
            {t("settings.about.viewThirdParty")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("settings.about.disclaimer")}
          description={t("settings.about.disclaimerDesc")}
        >
          <Tag icon={<FileProtectOutlined />} color="default">
            {t("settings.about.localExecutionBadge")}
          </Tag>
        </SettingRow>
      </SettingsSection>

      {/* Software & Diagnostics (替代原技术栈) */}
      <SettingsSection
        title={t("settings.about.softwareInfo")}
        actions={
          <Button icon={<CopyOutlined />} onClick={() => void handleCopyDiagnostics()}>
            {t("settings.about.copyDiagnostics")}
          </Button>
        }
      >
        <SettingRow label={t("settings.about.version")}>
          <span className="text-sm font-medium text-[var(--cs-text-primary)]">
            v{packageJson.version}
          </span>
        </SettingRow>
        <SettingRow label={t("settings.about.appId")}>
          <span className="break-all font-mono text-xs text-[var(--cs-text-secondary)]">
            com.termflow.desktop
          </span>
        </SettingRow>
      </SettingsSection>

      {/* License Modal */}
      <Modal
        title={t("settings.about.licenseModalTitle")}
        open={licenseModalOpen}
        onCancel={() => setLicenseModalOpen(false)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={() => void handleCopyLicense()}>
            {t("common.copy")}
          </Button>,
          <Button key="close" type="primary" onClick={() => setLicenseModalOpen(false)}>
            {t("common.close")}
          </Button>,
        ]}
        width={680}
      >
        <div className="py-2">
          <p className="mb-3 text-xs text-[var(--cs-text-tertiary)]">
            Termflow is released under the MIT License.
          </p>
          <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-4 font-mono text-xs leading-relaxed text-[var(--cs-text-secondary)] whitespace-pre-wrap select-text">
            {MIT_LICENSE_TEXT}
          </pre>
        </div>
      </Modal>

      {/* Third Party Notices Modal */}
      <Modal
        title={t("settings.about.thirdPartyModalTitle")}
        open={thirdPartyModalOpen}
        onCancel={() => setThirdPartyModalOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setThirdPartyModalOpen(false)}>
            {t("common.close")}
          </Button>,
        ]}
        width={720}
      >
        <div className="flex max-h-96 flex-col gap-3 overflow-auto py-2 pr-1">
          <p className="m-0 text-xs text-[var(--cs-text-secondary)]">
            {t("settings.about.thirdPartyNoticeIntro")}
          </p>
          <div className="flex flex-col gap-2.5">
            {THIRD_PARTY_LIBRARIES.map((lib) => (
              <div
                key={lib.name}
                className="flex items-center justify-between rounded-lg border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] px-3.5 py-2.5"
              >
                <div className="min-w-0 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[var(--cs-text-primary)]">
                      {lib.name}
                    </span>
                    <Tag className="!m-0 text-[10px]">{lib.license}</Tag>
                  </div>
                  <p className="mb-0 mt-1 text-xs text-[var(--cs-text-secondary)]">
                    {t(lib.descriptionKey)}
                  </p>
                </div>
                <Button
                  size="small"
                  type="text"
                  icon={<GlobalOutlined />}
                  onClick={() => openAboutLink(lib.url)}
                  aria-label={lib.name}
                />
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
export default AboutPage;
