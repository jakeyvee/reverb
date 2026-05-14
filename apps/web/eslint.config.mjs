import { FlatCompat } from "@eslint/eslintrc";
import { reactConfig } from "@reverb/config/eslint";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [...reactConfig, ...compat.extends("next/core-web-vitals")];
