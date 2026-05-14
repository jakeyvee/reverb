import type { Config } from "tailwindcss";

const preset: Config = {
  content: [],
  theme: {
    extend: {
      colors: {
        reverb: {
          50: "#f5f7ff",
          500: "#5b6bff",
          900: "#1a1f4d",
        },
      },
    },
  },
  plugins: [],
};

export default preset;
