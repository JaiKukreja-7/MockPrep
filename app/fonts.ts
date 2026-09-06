import localFont from "next/font/local";

/**
 * Archivo — the display face, pinned to the wdth 62 / wght 600 instance.
 *
 * The tokens call for a single display cut and forbid varying it, so this
 * ships one static instance rather than the variable font: 13KB instead of
 * 640KB, with no axis available to drift off-system. Subset to latin with
 * `tnum` kept, since display type carries the one big number per screen.
 */
export const archivo = localFont({
  src: "./fonts/Archivo-Display.woff2",
  weight: "600",
  style: "normal",
  display: "swap",
  variable: "--font-archivo",
});

/**
 * Switzer — everything else. Variable, 100–900, so the whole UI scale
 * comes out of one file.
 *
 * Neither loader declares `fallback`. next/font already appends its
 * metric-matched "<name> Fallback" face to the variable; the human-readable
 * stack lives once, in the --font-display / --font-body tokens.
 */
export const switzer = localFont({
  src: "./fonts/Switzer-Variable.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-switzer",
});
