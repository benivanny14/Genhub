// =============================================================================
// GENHUB - What a file actually is, not what it said it was
//
// The upload route picks the stored extension from the browser's `file.type`,
// which is a claim, not a fact: nothing stops a caller from sending AVIF bytes
// under `image/png`. That mattered more than a mislabelled file, because this
// app hands its own public uploads to next/image's optimiser, and the optimiser
// decodes by CONTENT. Next.js 14 decodes AVIF through sharp/libheif, and that
// path has a critical unauthenticated RCE (GHSA-2xp9-vwfh-vxw4, fixed only in
// 15.5.24+ by refusing to optimise AVIF at all). So "a PNG that is really an
// AVIF" was a route from a free account to code execution on the server.
//
// The app cannot configure Next 14 to refuse AVIF input, so it is refused here:
// a HEIF container is a HEIF container whatever it is called, and the two
// defences between that and the optimiser are this file (refuse the disguise at
// upload) and canOptimizeImage (never optimise a HEIF key).
//
// Pure and synchronous on purpose — it is called on the request path and is the
// kind of thing that has to be provable without a server.
// =============================================================================

/**
 * Brands that mark a file as a HEIF container (AVIF, HEIC, HEIF and relatives).
 *
 * All of them are decoded by the same libheif code path, and all of them are
 * served as-is by us rather than through the optimiser.
 */
const HEIF_BRANDS = new Set([
  "avif", // AVIF image
  "avis", // AVIF image sequence
  "heic", // HEVC image (iPhone photos)
  "heix",
  "heim",
  "heis",
  "hevc", // HEVC image sequence
  "hevx",
  "mif1", // HEIF generic / multi-image
  "msf1", // HEIF image sequence
]);

/**
 * True when the bytes are an ISO-BMFF (MP4-family) HEIF container.
 *
 * Layout: a 32-bit box size, the ASCII `ftyp`, then the major brand. Checking
 * the brand and not just `ftyp` matters — an MP4 video would otherwise match.
 */
export function isHeifContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return false;
  }
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return HEIF_BRANDS.has(brand);
}

/**
 * True when the extension on a stored key is a HEIF container.
 *
 * Used to keep such a file away from the optimiser, and kept beside the sniffer
 * so the two answers come from one file: what the bytes are and what the name
 * says must never disagree in a way that lets one of them be optimised.
 */
export function isHeifExtension(url: string | null | undefined): boolean {
  if (!url) return false;
  const withoutQuery = url.split(/[?#]/)[0].toLowerCase();
  return /\.(avif|heic|heif|heix|avis)$/.test(withoutQuery);
}
