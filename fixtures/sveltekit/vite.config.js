import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// The dependency cache lives in the copy the e2e runner makes, not in the
// node_modules it links from here.
export default defineConfig({ plugins: [sveltekit()], cacheDir: ".vite" });
