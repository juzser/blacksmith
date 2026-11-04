// The colours pr-mod draws with: Catppuccin pastels (Mocha under a dark theme, Latte under a light one).
// Green is success, red failure, yellow pending or a conflict.
export type PaletteRole = 'success' | 'error' | 'warning' | 'claude'
export type Palette = Readonly<Record<PaletteRole, string>>

/** Catppuccin Mocha, for a dark theme. */
export const MOCHA: Palette = { success: '#a6e3a1', error: '#f38ba8', warning: '#f9e2af', claude: '#fab387' }

/** Catppuccin Latte, for a light theme. */
export const LATTE: Palette = { success: '#40a02b', error: '#d20f39', warning: '#df8e1d', claude: '#fe640b' }

/** The engine's own theme keys: what a daltonized, `auto` or unknown theme, or an unread one, keeps. */
export const THEME_KEYS: Palette = { success: 'success', error: 'error', warning: 'warning', claude: 'claude' }

/** The palette for a `/config` theme name: Latte for `light*`, Mocha for `dark*`, the theme keys for anything else. */
export function paletteOf(theme: string | null | undefined): Palette {
  if (typeof theme !== 'string' || theme.includes('daltonized')) return THEME_KEYS
  if (theme.startsWith('light')) return LATTE
  if (theme.startsWith('dark')) return MOCHA
  return THEME_KEYS
}
