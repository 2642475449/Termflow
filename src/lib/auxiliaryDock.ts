import { useAuxiliaryDockStore } from "@/store/auxiliaryDock";
import type { AgentCliInfo } from "@/types";

export const OPEN_AUXILIARY_FILE_EVENT = "termflow:open-auxiliary-file";
export const OPEN_AUXILIARY_QUESTION_EVENT = "termflow:open-auxiliary-question";

export interface OpenAuxiliaryFileDetail {
  projectPath: string;
  path: string;
  preview?: boolean;
}

export function openAuxiliaryFile(detail: OpenAuxiliaryFileDetail) {
  window.dispatchEvent(new CustomEvent(OPEN_AUXILIARY_FILE_EVENT, { detail }));
}

export function openAuxiliarySession(input: {
  sessionId: string;
  projectPath: string;
  title: string;
  kind: "terminal" | "task";
}) {
  useAuxiliaryDockStore.getState().openSession(input);
}

export interface OpenAuxiliaryQuestionDetail {
  projectPath: string;
  agent: AgentCliInfo;
  prompt: string;
  question: string;
}

export function openAuxiliaryQuestion(detail: OpenAuxiliaryQuestionDetail) {
  window.dispatchEvent(new CustomEvent(OPEN_AUXILIARY_QUESTION_EVENT, { detail }));
}
