import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_$", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "error",
      "no-console": "warn",
      "eqeqeq": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
];
