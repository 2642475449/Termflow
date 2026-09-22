import { Button } from "antd";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import type { Session } from "@/types";
import "./SessionResumeView.css";

interface SessionResumeViewProps {
  session: Session;
  onResume: () => void;
}

export function SessionResumeView({ session, onResume }: SessionResumeViewProps) {
  const { t } = useTranslation();
  const agentId = session.agentId ?? "claude";
  const starting = session.status === "starting";
  const failed = session.status === "error";

  return (
    <div className="app-session-resume">
      <section className="app-session-resume__content" aria-busy={starting}>
        <div
          className="app-session-resume__indicator"
          role={starting ? "status" : undefined}
          aria-label={starting ? t("terminal.resumeConnecting") : undefined}
        >
          {starting && <span className="app-session-resume__ring" aria-hidden="true" />}
          <AgentIcon agentId={agentId} size={22} />
        </div>
        {!starting && (
          <>
            {failed && (
              <p className="app-session-resume__error" role="alert">
                {t("terminal.resumeUnavailableDesc")}
              </p>
            )}
            <Button
              size="small"
              icon={failed ? <ReloadOutlined /> : <ArrowRightOutlined />}
              onClick={onResume}
            >
              {t(failed ? "terminal.resumeRetry" : "terminal.resumeSession")}
            </Button>
          </>
        )}
      </section>
    </div>
  );
}
