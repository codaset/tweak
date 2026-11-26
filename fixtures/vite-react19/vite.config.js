import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dependency cache lives in the copy the e2e runner makes, not in the
// node_modules it links from here.
export default defineConfig({ plugins: [react()], cacheDir: ".vite" });
