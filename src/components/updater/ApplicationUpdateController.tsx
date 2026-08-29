import { ApplicationUpdateModal } from "./ApplicationUpdateModal";
import { useApplicationUpdater } from "@/hooks/useApplicationUpdater";
import { useAppStore } from "@/store";

export function ApplicationUpdateController() {
  const windowContextReady = useAppStore((state) => state.windowContextReady);
  const windowLabel = useAppStore((state) => state.windowLabel);
  useApplicationUpdater(windowContextReady && windowLabel === "main");
  return <ApplicationUpdateModal />;
}
