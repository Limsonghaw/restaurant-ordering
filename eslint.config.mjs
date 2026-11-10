import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    ignores: ["lib/data/**", "tests/data.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/data/mock/**", "**/mock/**"],
              message: "页面和组件必须使用 lib/data 唯一出口。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/data/supabase/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "next-env.d.ts",
    "docs/**",
    "supabase/**",
    "scripts/**",
  ]),
]);
