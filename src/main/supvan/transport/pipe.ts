/**
 * Transport-agnostic byte pipe. Every physical transport (Classic-BT SPP over
 * RFCOMM, USB HID, BLE GATT) implements this same interface; the protocol and
 * print state machine are written against it and never touch a socket directly.
 * Mirrors the reference's `spp_pipe.rs::SppPipe` trait, async-ified for Node.
 *
 * Framing note: the printer replies with variable-length 0x7E 0x5A frames. Over
 * RFCOMM this is a byte stream (the transport must reassemble one frame per
 * `read`); over BLE it arrives as GATT notifications. Reassembly is the
 * transport's job, so `read` resolves with exactly one response frame or null.
 */
export interface SppPipe {
  /** Write raw bytes (a 16-byte command frame or a 512-byte data frame). */
  write(data: Uint8Array): Promise<void>;

  /**
   * Read one response frame, waiting up to `timeoutMs`. Resolves with the frame
   * bytes, or null on timeout / no response.
   */
  read(timeoutMs: number): Promise<Uint8Array | null>;

  /** Discard any buffered input so the next `read` sees only fresh data. */
  drain?(): Promise<void>;

  /** Close the underlying channel. */
  close?(): Promise<void>;
}
