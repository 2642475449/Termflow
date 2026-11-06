import { DownOutlined, LoadingOutlined, RightOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";

export function TreeDisclosure({ expanded, loading }: { expanded: boolean; loading: boolean }) {
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 200);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return <span className="app-file-tree-arrow" aria-hidden="true">
    {loading && showLoading ? <LoadingOutlined spin /> : expanded ? <DownOutlined /> : <RightOutlined />}
  </span>;
}
