import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/web/client/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f5f5f1",
        ink: "#1b1c1a",
        muted: "#6f716c",
        faint: "#a2a49f",
        stroke: {
          DEFAULT: "#e4e4df",
          strong: "#c9cac4"
        },
        danger: {
          DEFAULT: "#b34a3c",
          soft: "#fbefec"
        },
        sage: {
          DEFAULT: "#59715e",
          soft: "#eef3ee"
        }
      },
      fontFamily: {
        sans: [
          "Avenir Next",
          "Pretendard Variable",
          "Pretendard",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif"
        ],
        display: ["Iowan Old Style", "Baskerville", "Times New Roman", "serif"]
      },
      boxShadow: {
        soft: "0 1px 2px rgba(25, 26, 24, 0.05), 0 8px 24px rgba(25, 26, 24, 0.035)",
        toast: "0 18px 50px rgba(20, 21, 19, 0.24)"
      },
      animation: {
        reveal: "reveal 180ms ease-out both",
        toast: "toast 260ms cubic-bezier(0.22, 1, 0.36, 1) both"
      },
      keyframes: {
        reveal: {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        toast: {
          from: { opacity: "0", transform: "translateY(12px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" }
        }
      }
    }
  },
  plugins: [forms]
};
