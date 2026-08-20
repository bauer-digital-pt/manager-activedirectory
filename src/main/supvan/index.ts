/**
 * SUPVAN E11 / T-series label-printing core (transport-agnostic).
 *
 * Byte-exact TypeScript port of the reference protocol
 * (https://github.com/heeen/supvan-cups). Pure functions + an async print state
 * machine that drives an injected `SppPipe`; no hardware or Electron deps.
 * See docs/supvan-e11-label-printing-plan.md.
 */
export * from "./constants.ts";
export * from "./frame.ts";
export * from "./data.ts";
export * from "./raster.ts";
export * from "./compress.ts";
export * from "./speed.ts";
export * from "./status.ts";
export * from "./job.ts";
export * from "./pipeline.ts";
export * from "./qr.ts";
export * from "./label.ts";
export type { SppPipe } from "./transport/pipe.ts";
