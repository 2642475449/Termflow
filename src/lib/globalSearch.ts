export const OPEN_GLOBAL_TEXT_SEARCH_EVENT = "termflow:open-global-text-search";

export interface OpenGlobalTextSearchDetail {
  scopePath?: string | null;
}

export function openGlobalTextSearch(scopePath?: string | null): void {
  window.dispatchEvent(
    new CustomEvent<OpenGlobalTextSearchDetail>(OPEN_GLOBAL_TEXT_SEARCH_EVENT, {
      detail: { scopePath: scopePath ?? null },
    })
  );
}
