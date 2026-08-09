import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const projectPath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

function appHtmlMetadata(): Plugin {
  const metadata = {
    description: "Public commitments backed by native GEN and resolved entirely on GenLayer Bradbury.",
    image: "",
    shortDescription: "GEN custody, resolution, and settlement on GenLayer.",
    title: "PromiseBond — Commit with conviction",
    twitterCard: "summary"
  };

  return {
    name: "app-html-metadata",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const transformed = html
          .replaceAll("__APP_TITLE__", metadata.title)
          .replaceAll("__APP_DESCRIPTION__", metadata.description)
          .replaceAll("__APP_SHORT_DESCRIPTION__", metadata.shortDescription)
          .replaceAll("__APP_IMAGE__", metadata.image)
          .replaceAll("__APP_TWITTER_CARD__", metadata.twitterCard);

        return metadata.image
          ? transformed
          : transformed.replace(/^\s*<meta (?:property="og:image"|name="twitter:image").*\/>\r?\n/gm, "");
      }
    }
  };
}

export default defineConfig(({ mode }) => {
  const envDir = projectPath("./config/promisebond");
  const environment = loadEnv(mode, envDir, "");
  const appEntry = projectPath("./src/promisebond-main.tsx");
  const apiPort = environment.PROMISEBOND_PORT || "8790";

  return {
    envDir,
    publicDir: false,
    resolve: {
      alias: {
        "@app-entry": appEntry
      }
    },
    build: {
      chunkSizeWarningLimit: 750,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("node_modules")) return;
          warn(warning);
        },
        output: {
          manualChunks(id) {
            if (id.includes("genlayer-js")) return "genlayer-vendor";
            if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react-vendor";
            return undefined;
          }
        }
      }
    },
    plugins: [appHtmlMetadata(), react()],
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`
      }
    }
  };
});
