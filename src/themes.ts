export interface ThemeDef {
  id: string;
  name: string;
  mode: "dark" | "light";
  /** Swatch dots shown in the settings picker. */
  preview: [string, string, string, string];
}

/**
 * Each theme overrides the same CSS variable ramps (`--color-stone-*` for
 * neutrals, `--color-clay-*` for the accent, `--color-sage-*` for AI accents)
 * in index.css, so every Tailwind utility rethemes automatically. Light themes
 * invert the ramp meaning: 950 is still "app background" and 100 is still
 * "strongest text".
 */
export const THEMES: ThemeDef[] = [
  { id: "clay", name: "Clay", mode: "dark", preview: ["#0c0a09", "#9a5b40", "#b4c4a6", "#dcb9a3"] },
  { id: "terra", name: "Terra", mode: "light", preview: ["#f4f1de", "#e07a5f", "#81b29a", "#3d405b"] },
  { id: "blossom", name: "Blossom", mode: "light", preview: ["#f7e1d7", "#edafb8", "#b0c4b1", "#4a5759"] },
  { id: "ember", name: "Ember", mode: "dark", preview: ["#241d0c", "#f58549", "#eec170", "#772f1a"] },
  { id: "pastel", name: "Pastel", mode: "light", preview: ["#faf7fc", "#ffafcc", "#a2d2ff", "#cdb4db"] },
  { id: "abyss", name: "Abyss", mode: "dark", preview: ["#03045e", "#00b4d8", "#90e0ef", "#caf0f8"] },
  { id: "lagoon", name: "Lagoon", mode: "dark", preview: ["#023047", "#ffb703", "#8ecae6", "#fb8500"] },
  { id: "marine", name: "Marine", mode: "dark", preview: ["#264653", "#e76f51", "#2a9d8f", "#e9c46a"] },
  { id: "grove", name: "Grove", mode: "light", preview: ["#fefae0", "#bc6c25", "#606c38", "#dda15e"] },
];

export const DEFAULT_THEME = "clay";

export function applyTheme(id: string) {
  document.documentElement.dataset.theme = id;
}
