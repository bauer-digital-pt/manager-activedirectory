/**
 * Print-speed selection from compressed buffer size.
 *
 * Byte-exact port of `speed.rs::calc_speed` / test_print.py calc_speed
 * (from T50PlusPrint.multiCompression). Lower speed for larger data gives the
 * thermal head enough time to heat. Thresholds are strict greater-than.
 */
export function calcSpeed(compressedSize: number): number {
  if (compressedSize > 3000) return 10;
  if (compressedSize > 2800) return 15;
  if (compressedSize > 2500) return 20;
  if (compressedSize > 2000) return 25;
  if (compressedSize > 1500) return 40;
  if (compressedSize > 1000) return 45;
  if (compressedSize > 500) return 55;
  return 60;
}
