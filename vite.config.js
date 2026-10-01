import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Agent worktrees (.claude/worktrees/*) are full repo copies -- keep their tests out of this run.
  test: { exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"] },
});
