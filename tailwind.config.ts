import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  // Custom CSS selectors in globals.css (html.dark, .dark *) are purged by the
  // JIT unless their class names appear as candidates in scanned content.
  // ThemeProvider toggles `dark` on <html>, so keep it no matter what.
  safelist: ["dark"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
        },
        surface: {
          // True-black neutral scale (Brazzers-style dark): page is near-black,
          // panels/cards sit slightly lighter — no violet tint.
          50: "#fafafa",
          100: "#0c0c0e",
          200: "#141416",
          300: "#1d1d20", // inputs / interactive surfaces
          400: "#121214", // cards / panels
          500: "#050506", // page background
          600: "#000000",
          700: "#000000",
          800: "#000000",
          900: "#000000",
        },
        accent: {
          cyan: "#06b6d4",
          teal: "#14b8a6",
          rose: "#f43f5e",
          amber: "#f59e0b",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Poppins", "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-up": "slideUp 0.3s ease-out",
        "slide-down": "slideDown 0.3s ease-out",
        "fade-in": "fadeIn 0.2s ease-out",
        glow: "glow 2s ease-in-out infinite alternate",
        // One entrance per kind of toast. A single shared motion made four
        // different messages read as the same message in four colours, which is
        // exactly what these four variants exist to stop.
        "toast-success": "toastSuccess 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        "toast-error": "toastError 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97) both",
        "toast-warning": "toastWarning 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
        "toast-info": "toastInfo 0.35s ease-out both",
      },
      keyframes: {
        slideUp: {
          "0%": { transform: "translateY(10px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        slideDown: {
          "0%": { transform: "translateY(-10px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        glow: {
          "0%": { boxShadow: "0 0 20px rgba(139, 92, 246, 0.3)" },
          "100%": { boxShadow: "0 0 40px rgba(139, 92, 246, 0.6)" },
        },
        // A success springs up: it overshoots a touch and settles, the way a
        // confirmation should feel.
        toastSuccess: {
          "0%": { opacity: "0", transform: "translateY(14px) scale(0.94)" },
          "60%": { opacity: "1", transform: "translateY(-3px) scale(1.015)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        // A refusal shakes into place, so it is felt rather than just read.
        toastError: {
          "0%": { opacity: "0", transform: "translateX(26px)" },
          "35%": { opacity: "1", transform: "translateX(-7px)" },
          "55%": { transform: "translateX(6px)" },
          "75%": { transform: "translateX(-3px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        // A warning arrives from the side with a slight lean, then straightens.
        toastWarning: {
          "0%": { opacity: "0", transform: "translateX(40px) skewX(-7deg)" },
          "100%": { opacity: "1", transform: "translateX(0) skewX(0deg)" },
        },
        // A notice grows quietly in place: information should not shout.
        toastInfo: {
          "0%": { opacity: "0", transform: "scale(0.92) translateY(6px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
