"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest } from "@/lib/api";

export type ProductBrand = {
  chinese_name: string;
  english_name: string;
  revision: number;
  updated_at?: string;
};

const defaultBrand: ProductBrand = { chinese_name: "逐梦帧", english_name: "逐梦帧", revision: 0 };

type ProductBrandContextValue = ProductBrand & {
  setProductBrand: (brand: ProductBrand) => void;
  refreshProductBrand: () => Promise<void>;
};

const ProductBrandContext = createContext<ProductBrandContextValue | undefined>(undefined);

export function ProductBrandProvider({ children }: { children: ReactNode }) {
  const [brand, setProductBrand] = useState<ProductBrand>(defaultBrand);
  const refreshProductBrand = useCallback(async () => {
    try { setProductBrand(await apiRequest<ProductBrand>("/client-config/product-brand")); }
    catch { /* Keep the bundled brand while the API is unavailable. */ }
  }, []);
  useEffect(() => { void refreshProductBrand(); }, [refreshProductBrand]);
  const value = useMemo(() => ({ ...brand, setProductBrand, refreshProductBrand }), [brand, refreshProductBrand]);
  return <ProductBrandContext.Provider value={value}>{children}</ProductBrandContext.Provider>;
}

export function useProductBrand(): ProductBrandContextValue {
  const value = useContext(ProductBrandContext);
  if (!value) throw new Error("useProductBrand must be used inside ProductBrandProvider");
  return value;
}
