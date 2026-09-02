import { expect, test } from "vitest";
import { getFileExtension, supportsOfficePreview } from "./officePreview";

test("识别常见 Office 和 OpenDocument 格式", () => {
  expect(supportsOfficePreview("C:\\project\\合同.DOCX")).toBe(true);
  expect(supportsOfficePreview("/project/report.xlsx")).toBe(true);
  expect(supportsOfficePreview("/project/slides.odp")).toBe(true);
});

test("不把未知二进制文件交给 Office 预览器", () => {
  expect(supportsOfficePreview("/project/archive.zip")).toBe(false);
  expect(supportsOfficePreview("/project/tool.exe")).toBe(false);
  expect(supportsOfficePreview("/project/README")).toBe(false);
});

test("仅从最终文件名提取扩展名", () => {
  expect(getFileExtension("C:\\folder.with.dot\\report.XLSX")).toBe("xlsx");
  expect(getFileExtension("C:\\folder.with.dot\\README")).toBe("");
});
