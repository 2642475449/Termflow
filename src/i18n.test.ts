import { afterEach, describe, expect, it } from "vitest";
import i18n, { toI18nLanguage } from "./i18n";
import enUS from "./locales/en-US.json";
import jaJP from "./locales/ja-JP.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

function flattenTranslationKeys(
  value: unknown,
  prefix = "",
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    flattenTranslationKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translation catalog parity", () => {
  it("keeps every locale on the same key set", () => {
    const expectedKeys = flattenTranslationKeys(zhCN).sort();
    for (const catalog of [zhTW, enUS, jaJP]) {
      expect(flattenTranslationKeys(catalog).sort()).toEqual(expectedKeys);
    }
  });
});

describe("Japanese translations", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("maps the application language to the Japanese locale", () => {
    expect(toI18nLanguage("ja")).toBe("ja-JP");
  });

  it("uses the Japanese resource without the English override", async () => {
    await i18n.changeLanguage("ja-JP");

    expect(i18n.t("home.overview.heroTitle")).toBe("プロジェクト概要");
    expect(i18n.t("home.overview.title")).toBe("アクティビティヒートマップ");
  });
});
