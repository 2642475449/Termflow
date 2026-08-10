import { useEffect, useMemo, useState } from "react";
import {
  CaretDownOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  DownOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  SearchOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Pagination,
  Select,
  Tag,
  Tooltip,
  message,
} from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { getAgentDisplayName } from "@/lib/agents";
import {
  filterAndSortArchivedRows,
  normalizeArchivedSessionGroups,
  type AgentFilter,
  type ArchiveSort,
  type ArchivedRow,
} from "@/lib/archivedSessions";
import { useAppStore } from "@/store";
import type { AgentId, AiAgentId, Session } from "@/types";

const PAGE_SIZE_OPTIONS = [20, 50, 100];

function archiveKey(projectPath: string, sessionId: string) {
  return `${projectPath}\u0000${sessionId}`;
}

function sessionAgent(session: Session): AgentId {
  return session.agentId ?? "claude";
}

function agentName(agentId: AgentId) {
  if (agentId === "powershell") return "PowerShell";
  if (agentId === "cmd") return "CMD";
  return getAgentDisplayName(agentId as AiAgentId);
}

function projectNameFromPath(projectPath: string) {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
}

function isSameDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function ArchivedSessionsPage() {
  const { t, i18n } = useTranslation();
  const [modal, modalContextHolder] = Modal.useModal();
  const [messageApi, messageContextHolder] = message.useMessage();
  const projectArchivedSessions = useAppStore((state) => state.projectArchivedSessions);
  const unarchiveSession = useAppStore((state) => state.unarchiveSession);
  const deleteArchivedSession = useAppStore((state) => state.deleteArchivedSession);
  const deleteAllArchivedSessions = useAppStore((state) => state.deleteAllArchivedSessions);

  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sort, setSort] = useState<ArchiveSort>("recent");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const archivedSessionGroups = useMemo(
    () => normalizeArchivedSessionGroups(projectArchivedSessions),
    [projectArchivedSessions]
  );

  const allRows = useMemo<ArchivedRow[]>(() => Object.entries(archivedSessionGroups)
    .flatMap(([projectPath, sessions]) => {
      const projectName = projectNameFromPath(projectPath);
      return sessions.map((session) => ({ projectPath, projectName, session }));
    }), [archivedSessionGroups]);

  const projectOptions = useMemo(() => Object.entries(archivedSessionGroups)
    .filter(([, sessions]) => sessions.length > 0)
    .map(([projectPath, sessions]) => ({
      value: projectPath,
      label: `${projectNameFromPath(projectPath)} (${sessions.length})`,
    }))
    .sort((left, right) => left.label.localeCompare(right.label)), [archivedSessionGroups]);

  const availableAgents = useMemo(() => Array.from(new Set(allRows.map(({ session }) => sessionAgent(session))))
    .sort((left, right) => agentName(left).localeCompare(agentName(right))), [allRows]);

  const filteredRows = useMemo(() => {
    return filterAndSortArchivedRows(allRows, {
      query,
      agent: agentFilter,
      project: projectFilter,
      sort,
    });
  }, [agentFilter, allRows, projectFilter, query, sort]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const groupedPageRows = useMemo(() => {
    const groups = new Map<string, ArchivedRow[]>();
    pageRows.forEach((row) => {
      const group = groups.get(row.projectPath) ?? [];
      group.push(row);
      groups.set(row.projectPath, group);
    });
    return Array.from(groups.entries());
  }, [pageRows]);

  const pageKeys = pageRows.map((row) => archiveKey(row.projectPath, row.session.id));
  const selectedRows = allRows.filter((row) => selectedKeys.has(archiveKey(row.projectPath, row.session.id)));
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.has(key));
  const somePageSelected = pageKeys.some((key) => selectedKeys.has(key));

  useEffect(() => {
    const existingKeys = new Set(allRows.map((row) => archiveKey(row.projectPath, row.session.id)));
    setSelectedKeys((current) => new Set(Array.from(current).filter((key) => existingKeys.has(key))));
  }, [allRows]);

  useEffect(() => {
    const finalPage = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (page > finalPage) setPage(finalPage);
  }, [filteredRows.length, page, pageSize]);

  function archiveTime(timestamp?: number) {
    if (!timestamp) return { primary: "-", secondary: "" };
    const date = new Date(timestamp);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = date.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
    const primary = isSameDay(date, now)
      ? t("settings.archived.todayAt", { time, defaultValue: `今天 ${time}` })
      : isSameDay(date, yesterday)
        ? t("settings.archived.yesterdayAt", { time, defaultValue: `昨天 ${time}` })
        : date.toLocaleString(i18n.language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return { primary, secondary: date.toLocaleString(i18n.language) };
  }

  function togglePageSelection(checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      pageKeys.forEach((key) => checked ? next.add(key) : next.delete(key));
      return next;
    });
  }

  function toggleRow(projectPath: string, sessionId: string, checked: boolean) {
    const key = archiveKey(projectPath, sessionId);
    setSelectedKeys((current) => {
      const next = new Set(current);
      checked ? next.add(key) : next.delete(key);
      return next;
    });
  }

  function restoreSession(row: ArchivedRow) {
    unarchiveSession(row.projectPath, row.session.id);
    messageApi.success(t("settings.archived.sessionUnarchived"));
  }

  function confirmDeleteSession(row: ArchivedRow) {
    modal.confirm({
      title: t("settings.archived.confirmDelete"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: () => {
        deleteArchivedSession(row.projectPath, row.session.id);
        messageApi.success(t("settings.archived.sessionDeleted"));
      },
    });
  }

  function restoreSelectedSessions() {
    selectedRows.forEach((row) => unarchiveSession(row.projectPath, row.session.id));
    messageApi.success(t("settings.archived.sessionsRestored", {
      count: selectedRows.length,
      defaultValue: `已恢复 ${selectedRows.length} 个会话`,
    }));
    setSelectedKeys(new Set());
  }

  function confirmDeleteAll() {
    modal.confirm({
      title: t("settings.archived.confirmDeleteAllGlobal", {
        count: allRows.length,
        defaultValue: `永久删除全部 ${allRows.length} 个归档会话？此操作不可撤销。`,
      }),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: () => {
        Object.keys(projectArchivedSessions).forEach(deleteAllArchivedSessions);
        messageApi.success(t("settings.archived.allDeleted"));
      },
    });
  }

  return (
    <div>
      {modalContextHolder}
      {messageContextHolder}
      <SettingsPageHeader
        title={
          <div className="flex flex-wrap items-center gap-2.5">
            <span>{t("settings.archived.title")}</span>
            <Tag className="app-glass-card !m-0 rounded-md px-2 py-0.5 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.archived.countLabel", { count: allRows.length })}
            </Tag>
          </div>
        }
        description={t("settings.archived.headerDesc")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
          allowClear
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
          placeholder={t("settings.archived.searchPlaceholder", { defaultValue: "搜索归档会话" })}
          className="min-w-[240px] flex-1"
        />
        <Select<AgentFilter>
          value={agentFilter}
          onChange={(value) => { setAgentFilter(value); setPage(1); }}
          className="w-[190px]"
          options={[
            { value: "all", label: t("settings.archived.allAgents", { defaultValue: "全部智能体" }) },
            ...availableAgents.map((agentId) => ({
              value: agentId,
              label: <span className="inline-flex items-center gap-2"><AgentIcon agentId={agentId} size={14} />{agentName(agentId)}</span>,
            })),
          ]}
        />
        <Select
          value={projectFilter}
          onChange={(value) => { setProjectFilter(value); setPage(1); }}
          className="w-[190px]"
          options={[
            { value: "all", label: t("settings.archived.allProjects", { defaultValue: "全部项目" }) },
            ...projectOptions,
          ]}
        />
        <Select<ArchiveSort>
          value={sort}
          onChange={(value) => setSort(value)}
          suffixIcon={<DownOutlined />}
          className="w-[145px]"
          options={[
            { value: "recent", label: t("settings.archived.sortRecent", { defaultValue: "最近归档" }) },
            { value: "oldest", label: t("settings.archived.sortOldest", { defaultValue: "最早归档" }) },
            { value: "name", label: t("settings.archived.sortName", { defaultValue: "按名称" }) },
          ]}
        />
          <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              ...(selectedRows.length > 0 ? [
                {
                  key: "restore-selected",
                  icon: <UndoOutlined />,
                  label: t("settings.archived.restoreSelected", { defaultValue: "恢复所选会话" }),
                },
                { type: "divider" as const },
              ] : []),
              {
                key: "delete-all",
                danger: true,
                icon: <DeleteOutlined />,
                label: t("settings.archived.deleteAll", { defaultValue: "全部删除" }),
                disabled: allRows.length === 0,
              },
            ],
            onClick: ({ key }) => {
              if (key === "restore-selected") restoreSelectedSessions();
              if (key === "delete-all") confirmDeleteAll();
            },
          }}
          >
            <Button icon={<MoreOutlined />} aria-label={t("common.more", { defaultValue: "更多" })} />
          </Dropdown>
        </div>
      </SettingsPageHeader>

      <div
        className="app-glass-card overflow-hidden rounded-lg"
        style={{
          background: "var(--cs-bg-card)",
          border: "1px solid var(--cs-border-card)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {allRows.length === 0 ? (
          <div className="py-16">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div>
                  <div style={{ color: "var(--cs-text-secondary)" }}>{t("settings.archived.empty")}</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.archived.emptyDesc")}</div>
                </div>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[880px]">
              <div
                className="grid h-11 grid-cols-[36px_minmax(280px,1.7fr)_minmax(160px,.7fr)_minmax(180px,.7fr)_92px] items-center gap-4 px-4 text-xs font-medium"
                style={{ borderBottom: "1px solid var(--cs-border-card)", color: "var(--cs-text-secondary)" }}
              >
                <Checkbox
                  checked={allPageSelected}
                  indeterminate={!allPageSelected && somePageSelected}
                  onChange={(event) => togglePageSelection(event.target.checked)}
                />
                <span className="flex items-center gap-2">
                  {t("settings.archived.columnSession", { defaultValue: "会话" })}
                  {selectedRows.length > 0 ? (
                    <span style={{ color: "var(--cs-primary)" }}>
                      {t("settings.archived.selectedInline", {
                        count: selectedRows.length,
                        defaultValue: `已选 ${selectedRows.length}`,
                      })}
                    </span>
                  ) : null}
                </span>
                <span>{t("settings.archived.columnAgent", { defaultValue: "智能体" })}</span>
                <span>{t("settings.archived.columnArchivedAt", { defaultValue: "归档时间" })}</span>
                <span className="text-center">{t("settings.archived.columnActions", { defaultValue: "操作" })}</span>
              </div>

              {filteredRows.length === 0 ? (
                <div className="py-14">
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("settings.archived.noResults", { defaultValue: "没有符合条件的归档会话" })} />
                </div>
              ) : groupedPageRows.map(([projectPath, rows]) => {
                const collapsed = collapsedProjects.has(projectPath);
                const totalInProject = filteredRows.filter((row) => row.projectPath === projectPath).length;
                return (
                  <div key={projectPath}>
                    <button
                      type="button"
                      className="flex h-11 w-full items-center gap-2 border-0 bg-transparent px-4 text-left"
                      style={{ borderBottom: "1px solid var(--cs-border-card)", color: "var(--cs-text-primary)" }}
                      onClick={() => setCollapsedProjects((current) => {
                        const next = new Set(current);
                        next.has(projectPath) ? next.delete(projectPath) : next.add(projectPath);
                        return next;
                      })}
                    >
                      {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
                      <FolderOpenOutlined style={{ color: "var(--cs-accent-yellow)" }} />
                      <span className="text-sm font-medium">{rows[0].projectName}</span>
                      <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{totalInProject}</span>
                    </button>
                    {!collapsed ? rows.map((row) => {
                      const key = archiveKey(row.projectPath, row.session.id);
                      const agentId = sessionAgent(row.session);
                      const time = archiveTime(row.session.archivedAt);
                      return (
                        <div
                          key={key}
                          className="group grid min-h-[58px] grid-cols-[36px_minmax(280px,1.7fr)_minmax(160px,.7fr)_minmax(180px,.7fr)_92px] items-center gap-4 px-4 transition-colors hover:bg-[var(--cs-bg-hover)]"
                          style={{ borderBottom: "1px solid var(--cs-border-card)" }}
                        >
                          <Checkbox
                            checked={selectedKeys.has(key)}
                            onChange={(event) => toggleRow(row.projectPath, row.session.id, event.target.checked)}
                          />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium" title={row.session.name} style={{ color: "var(--cs-text-primary)" }}>
                              {row.session.name}
                            </div>
                          </div>
                          <div className="flex min-w-0 items-center gap-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                            <AgentIcon agentId={agentId} size={17} />
                            <span className="truncate">{agentName(agentId)}</span>
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>{time.primary}</div>
                            {time.secondary ? <div className="mt-0.5 truncate text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{time.secondary}</div> : null}
                          </div>
                          <div className="flex items-center justify-center gap-1">
                            <Tooltip title={t("settings.archived.unarchive")}>
                              <Button
                                size="small"
                                type="text"
                                icon={<UndoOutlined />}
                                onClick={() => restoreSession(row)}
                              />
                            </Tooltip>
                            <Dropdown
                              trigger={["click"]}
                              menu={{
                                items: [{ key: "delete", danger: true, icon: <DeleteOutlined />, label: t("settings.archived.delete") }],
                                onClick: ({ key: action }) => { if (action === "delete") confirmDeleteSession(row); },
                              }}
                            >
                              <Button size="small" type="text" icon={<MoreOutlined />} aria-label={t("common.more", { defaultValue: "更多" })} />
                            </Dropdown>
                          </div>
                        </div>
                      );
                    }) : null}
                  </div>
                );
              })}

              {filteredRows.length > 0 ? (
                <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-4 py-2">
                  <span className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>
                    {t("settings.archived.sessionCount", { count: filteredRows.length, defaultValue: `共 ${filteredRows.length} 个会话` })}
                  </span>
                  <Pagination
                    size="small"
                    current={page}
                    pageSize={pageSize}
                    total={filteredRows.length}
                    showSizeChanger
                    pageSizeOptions={PAGE_SIZE_OPTIONS}
                    onChange={(nextPage, nextPageSize) => {
                      setPage(nextPageSize === pageSize ? nextPage : 1);
                      setPageSize(nextPageSize);
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ArchivedSessionsPage;
