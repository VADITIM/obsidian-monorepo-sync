import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { ignores: ["main.js", "node_modules/", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: "./tsconfig.json" } },
  },
]);
