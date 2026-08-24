/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        ok: {
          DEFAULT: "hsl(var(--ok))",
          foreground: "hsl(var(--ok-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Environment identity. Deliberately disjoint from the state palette
        // (ok = enabled, destructive = killed) so an env colour can never be
        // misread as a flag state. See src/lib/envColors.ts.
        // Variant series: categorical colours for per-variation bars and lines. Disjoint
        // from the state palette AND from env identity — see src/lib/variantSeries.ts.
        series: {
          1: "hsl(var(--series-1))",
          2: "hsl(var(--series-2))",
          3: "hsl(var(--series-3))",
          4: "hsl(var(--series-4))",
          5: "hsl(var(--series-5))",
        },
        env: {
          dev: "hsl(var(--env-dev))",
          "dev-foreground": "hsl(var(--env-dev-foreground))",
          staging: "hsl(var(--env-staging))",
          "staging-foreground": "hsl(var(--env-staging-foreground))",
          production: "hsl(var(--env-production))",
          "production-foreground": "hsl(var(--env-production-foreground))",
          neutral: "hsl(var(--env-neutral))",
          "neutral-foreground": "hsl(var(--env-neutral-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
}
