import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/web/client/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          page: "#fafafa",
          panel: "#ffffff",
          subtle: "#f5f5f5"
        },
        ink: {
          strong: "#171717",
          base: "#262626",
          muted: "#737373",
          faint: "#a3a3a3"
        },
        line: {
          base: "#e5e5e5",
          strong: "#d4d4d4"
        },
        action: {
          base: "#2563eb",
          hover: "#1d4ed8",
          faint: "#eff6ff"
        },
        danger: {
          base: "#dc2626",
          hover: "#b91c1c",
          faint: "#fef2f2"
        },
        success: {
          base: "#16a34a",
          faint: "#f0fdf4"
        },
        warning: {
          base: "#ca8a04",
          faint: "#fefce8"
        }
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ]
      }
    }
  },
  plugins: [forms]
};
