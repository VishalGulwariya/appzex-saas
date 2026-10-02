const tsParser = require("@typescript-eslint/parser");

module.exports = [
  { ignores: ["dist/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
    rules: { "no-duplicate-imports": "error", "no-unreachable": "error" }
  }
];
