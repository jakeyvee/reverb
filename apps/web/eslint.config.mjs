import { FlatCompat } from "@eslint/eslintrc";
import { reactConfig } from "@reverb/config/eslint";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  { ignores: ["next-env.d.ts", ".next/**", ".turbo/**"] },
  ...reactConfig,
  ...compat.extends("next/core-web-vitals"),
];

export default config;
