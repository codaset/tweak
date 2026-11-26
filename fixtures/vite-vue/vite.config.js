import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The dependency cache lives in the copy the e2e runner makes, not in the
// node_modules it links from here.
export default defineConfig({ plugins: [vue()], cacheDir: ".vite" });
