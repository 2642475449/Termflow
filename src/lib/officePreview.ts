const OFFICE_PREVIEW_EXTENSIONS = new Set([
  "doc",
  "docx",
  "dot",
  "dotx",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "ods",
  "csv",
  "ppt",
  "pptx",
  "ppsx",
  "odp",
]);

export function getFileExtension(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

export function supportsOfficePreview(path: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.has(getFileExtension(path));
}
