import { FolderOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { projectPathKey } from "@/lib/openProjects";
import { getProjectIconColor, getProjectIconSource } from "@/lib/projectIcons";
import { useProjectIconsStore } from "@/store/slices/projectIcons";
import type { ProjectIconPreference } from "@/store/types";
import "./ProjectIcon.css";

export function ProjectIconGlyph({ name, color, preference, detected, compact = false, onImageError }: {
  name: string; color: number; preference?: ProjectIconPreference; detected?: string | null;
  compact?: boolean; onImageError?: (src: string) => void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = getProjectIconSource(preference, detected);
  const src = source && source !== failedSource ? source : null;
  const initials = /^[a-z\d]/i.test(name.trim()) ? name.trim().slice(0, 2).toUpperCase() : null;
  const emoji = preference?.mode === "emoji" ? preference.emoji : null;
  return (
    <span className={`app-project-icon${compact ? " app-project-icon--compact" : ""}${src ? " app-project-icon--image" : ` app-project-icon--swatch-${color}`}${emoji ? " app-project-icon--emoji" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} onError={() => { setFailedSource(src); onImageError?.(src); }} /> : emoji ?? initials ?? <FolderOutlined />}
    </span>
  );
}

export function ProjectIcon({ path, name, compact = false, refresh = false }: {
  path: string; name: string; compact?: boolean; refresh?: boolean;
}) {
  const key = projectPathKey(path);
  const detected = useProjectIconsStore((state) => state.icons[key]?.src);
  const preference = useProjectIconsStore((state) => state.preferences[key]);
  const color = useProjectIconsStore((state) => state.colors[key]);
  const initialized = useProjectIconsStore((state) => state.initialized);
  const setProjectIcon = useProjectIconsStore((state) => state.setProjectIcon);
  const setProjectIconFailed = useProjectIconsStore((state) => state.setProjectIconFailed);
  useEffect(() => { if (initialized) void setProjectIcon(path); }, [path, refresh, initialized, setProjectIcon]);
  return <ProjectIconGlyph name={name} compact={compact} color={preference?.color ?? color ?? getProjectIconColor(path || name, 6)} preference={preference} detected={detected} onImageError={(src) => setProjectIconFailed(path, src)} />;
}
