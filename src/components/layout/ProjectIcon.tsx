import { FolderOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { projectPathKey } from "@/lib/openProjects";
import { useProjectIconsStore } from "@/store/slices/projectIcons";
import "./ProjectIcon.css";

export function ProjectIcon({ path, name, compact = false, refresh = false }: {
  path: string;
  name: string;
  compact?: boolean;
  refresh?: boolean;
}) {
  const src = useProjectIconsStore((state) => state.icons[projectPathKey(path)]?.src);
  const setProjectIcon = useProjectIconsStore((state) => state.setProjectIcon);
  const setProjectIconFailed = useProjectIconsStore((state) => state.setProjectIconFailed);
  useEffect(() => { void setProjectIcon(path); }, [path, refresh, setProjectIcon]);
  const initials = /^[a-z\d]/i.test(name.trim()) ? name.trim().slice(0, 2).toUpperCase() : null;

  return (
    <span className={`app-project-icon${compact ? " app-project-icon--compact" : ""}${src ? " app-project-icon--image" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} onError={() => setProjectIconFailed(path, src)} /> : initials ?? <FolderOutlined />}
    </span>
  );
}
