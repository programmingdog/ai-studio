import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getClientProductBrand, type ClientProductBrand } from "../services/platform";
import { useI18n } from "../i18n";

const STORAGE_KEY = "aivs.product-brand";
const defaultBrand: ClientProductBrand = { chinese_name: "影匠", english_name: "Yingjiang", revision: 0 };

type ProductBrandContextValue = ClientProductBrand & { productName: string };
const ProductBrandContext = createContext<ProductBrandContextValue | undefined>(undefined);

function cachedBrand(): ClientProductBrand {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<ClientProductBrand> | null;
    return value && typeof value.chinese_name === "string" && value.chinese_name.trim() && typeof value.english_name === "string" && value.english_name.trim()
      ? { ...defaultBrand, ...value, chinese_name: value.chinese_name.trim(), english_name: value.english_name.trim() }
      : defaultBrand;
  } catch { return defaultBrand; }
}

export function ProductBrandProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [brand, setBrand] = useState<ClientProductBrand>(cachedBrand);
  const productName = locale === "zh-CN" || locale === "zh-TW" ? brand.chinese_name : brand.english_name;

  useEffect(() => {
    let active = true;
    void getClientProductBrand().then(result => {
      if (!active) return;
      setBrand(result);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.title = productName;
    if ("__TAURI_INTERNALS__" in window) void getCurrentWindow().setTitle(productName).catch(() => {});
  }, [productName]);

  const value = useMemo(() => ({ ...brand, productName }), [brand, productName]);
  return <ProductBrandContext.Provider value={value}>{children}</ProductBrandContext.Provider>;
}

export function useProductBrand(): ProductBrandContextValue {
  const value = useContext(ProductBrandContext);
  if (!value) throw new Error("useProductBrand must be used inside ProductBrandProvider");
  return value;
}
