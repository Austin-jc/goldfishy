/**
 * Origami goldfish mark — flat angular folds over a warm gold gradient.
 * Facet shading is done with translucent black/white overlays so the
 * gradient stays the single source of color.
 */
export default function GoldfishLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-label="GoldFishy"
      role="img"
    >
      <defs>
        <linearGradient id="gf-grad" x1="4" y1="8" x2="44" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd166" />
          <stop offset="0.55" stopColor="#f59e4b" />
          <stop offset="1" stopColor="#e2533f" />
        </linearGradient>
      </defs>
      {/* tail — two folded triangles */}
      <polygon points="2,13 16,24 2,35" fill="url(#gf-grad)" />
      <polygon points="2,13 16,24 9,24" fill="#fff" opacity="0.18" />
      <polygon points="2,35 16,24 9,24" fill="#000" opacity="0.18" />
      {/* body — kite fold */}
      <polygon points="12,24 27,9 45,24 27,39" fill="url(#gf-grad)" />
      {/* lower body fold shadow */}
      <polygon points="12,24 27,39 45,24" fill="#000" opacity="0.14" />
      {/* head crease highlight */}
      <polygon points="27,9 45,24 33,24" fill="#fff" opacity="0.14" />
      {/* dorsal fin fold */}
      <polygon points="20,16 27,9 30,15" fill="#000" opacity="0.12" />
      {/* eye */}
      <circle cx="37" cy="21" r="1.9" fill="#402013" />
    </svg>
  );
}
