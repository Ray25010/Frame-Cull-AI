import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const edition = process.env.FRAMECULL_EDITION === "PRO" ? "PRO" : "FLASH";
const editionLower = edition.toLowerCase();
const productDisplayName = edition === "PRO" ? "FrameCull AI Pro" : "FrameCull AI Flash";
const productEditionName = edition === "PRO" ? "Pro" : "Flash";

function framecullBrandHtml(): Plugin {
  return {
    name: "framecull-brand-html",
    transformIndexHtml(html) {
      return html
        .replace(/<title>.*?<\/title>/, `<title>${productDisplayName}</title>`)
        .replace(/FrameCull AI(?: Flash| Pro)? v0\.1\.6/g, `${productDisplayName} v0.1.6`);
    },
  };
}

export default defineConfig(async ({ command, mode }) => {
  const isProductionBuild = command === "build" && mode === "production";

  return {
    plugins: [framecullBrandHtml(), react()],
    clearScreen: false,
    define: {
      __FRAMECULL_EDITION__: JSON.stringify(edition),
      __FRAMECULL_PRODUCT_DISPLAY_NAME__: JSON.stringify(productDisplayName),
      __FRAMECULL_PRODUCT_EDITION_NAME__: JSON.stringify(productEditionName),
    },
    resolve: {
      alias: {
        "@edition/RawEngineSection": resolve(__dirname, `src/editions/RawEngineSection.${editionLower}.tsx`),
        "@edition/useRawMonitorFeature": resolve(__dirname, `src/editions/useRawMonitorFeature.${editionLower}.ts`),
        "@edition/useRawMonitorViewerFrame": resolve(__dirname, `src/editions/useRawMonitorViewerFrame.${editionLower}.ts`),
        "@edition/useMonitorLut": resolve(__dirname, `src/editions/useMonitorLut.${editionLower}.ts`),
        "@edition/buildAiPickedPhotoIds": resolve(__dirname, `src/editions/buildAiPickedPhotoIds.${editionLower}.ts`),
        "@edition/extendAboutPanelContent": resolve(__dirname, `src/editions/extendAboutPanelContent.${editionLower}.ts`),
        "@edition/RawEngineNotice": resolve(__dirname, `src/editions/RawEngineNotice.${editionLower}.tsx`),
      },
      conditions: ["onnxruntime-web-use-extern-wasm", "browser", "module", "import", "default"],
    },
    server: {
      port: 3000,
      strictPort: false,
      host: host || "127.0.0.1",
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 3001,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    optimizeDeps: {
      exclude: ["libraw-wasm"],
      esbuildOptions: {
        target: "es2022",
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      minify: "esbuild",
    },
    esbuild: {
      legalComments: "none",
      drop: isProductionBuild ? ["console", "debugger"] : [],
    },
    worker: {
      format: "es" as const,
    },
  };
});
