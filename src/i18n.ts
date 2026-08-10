import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import enUS from "./locales/en-US.json";
import jaJP from "./locales/ja-JP.json";

export function toI18nLanguage(language: "zh_CN" | "zh_TW" | "en" | "ja") {
  switch (language) {
    case "en":
      return "en-US";
    case "zh_TW":
      return "zh-TW";
    case "ja":
      return "ja-JP";
    default:
      return "zh-CN";
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "zh-TW": { translation: zhTW },
    "en-US": { translation: enUS },
    "ja-JP": { translation: jaJP },
  },
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
