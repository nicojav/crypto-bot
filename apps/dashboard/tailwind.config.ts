import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#0e0e10",
        card: "#17171a",
        "card-hover": "#1e1e22",
        surface: "#1e1e22",
        border: "#2a2a2e",
        "border-bright": "#3a3a42",
        green: {
          DEFAULT: "#34d399",
          dim: "#059669",
          bg: "rgba(52,211,153,0.08)",
        },
        red: {
          DEFAULT: "#f87171",
          dim: "#dc2626",
          bg: "rgba(248,113,113,0.08)",
        },
        amber: {
          DEFAULT: "#fbbf24",
          dim: "#d97706",
          bg: "rgba(251,191,36,0.08)",
        },
        text: {
          1: "#f0f0f2",
          2: "#8a8a95",
          3: "#45454e",
        },
      },
      fontFamily: {
        sans: ["Outfit", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      borderRadius: {
        card: "14px",
      },
      animation: {
        "kill-pulse": "kill-pulse 2.5s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.2s ease-out",
      },
      keyframes: {
        "kill-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(248,113,113,0.4)" },
          "50%": { boxShadow: "0 0 0 8px rgba(248,113,113,0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
