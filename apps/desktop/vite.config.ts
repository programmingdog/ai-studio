import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Cargo owns this tree. Watching its Windows DLLs causes EBUSY while
      // rustc/link.exe replace build artifacts during `tauri dev`.
      ignored: ["**/src-tauri/**"],
    },
  },
});
