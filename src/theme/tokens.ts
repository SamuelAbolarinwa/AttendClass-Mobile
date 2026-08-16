/**
 * src/theme/tokens.ts
 *
 * Design tokens for AttendClass mobile, sourced directly from the web app's
 * index.css design system (the indigo primary scale, neutrals, semantic colours,
 * spacing, typography, and radii).
 */

export const T = {
  colors: {
    // ── Indigo primary scale (matches web --color-primary-*) ────────────────
    primary50:  '#eef2ff',
    primary100: '#e0e7ff',
    primary200: '#c7d2fe',
    primary400: '#818cf8',
    primary:    '#6366f1',  // 500
    primary600: '#4f46e5',
    primary700: '#4338ca',
    primary800: '#3730a3',
    primary900: '#312e81',

    // ── Neutrals (matches web --color-bg, --color-surface, etc.) ────────────
    bg:             '#f8fafc',
    surface:        '#ffffff',
    border:         '#e2e8f0',
    borderStrong:   '#cbd5e1',
    text:           '#0f172a',
    textSecondary:  '#475569',
    textMuted:      '#94a3b8',

    // ── Semantic ─────────────────────────────────────────────────────────────
    success:    '#059669',
    successBg:  '#ecfdf5',
    warning:    '#d97706',
    warningBg:  '#fffbeb',
    error:      '#e11d48',
    errorBg:    '#fff1f2',

    // ── Input-specific (so text is always visible on any background) ─────────
    inputBg:         '#f8fafc',
    inputText:       '#0f172a',   // ← explicit dark text — fixes white-on-white
    inputPlaceholder: '#94a3b8',
    inputBorder:     '#e2e8f0',
    inputBorderFocus: '#6366f1',
  },

  spacing: {
    xs:  4,
    sm:  8,
    md:  16,
    lg:  20,
    xl:  28,
    xxl: 40,
  },

  fontSize: {
    xs:   11,
    sm:   13,
    base: 16,
    lg:   18,
    xl:   22,
    xxl:  28,
  },

  radius: {
    sm:  6,
    md:  10,
    lg:  16,
    xl:  24,
    full: 9999,
  },

  shadow: {
    sm: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.07,
      shadowRadius: 6,
      elevation: 4,
    },
  },
} as const;

// Convenience alias
export type ThemeColors = typeof T.colors;
