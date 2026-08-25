// picomatch ships no type declarations and @types/picomatch is outside the
// dependency allowlist (docs/specs/black-smith-architecture.md build order,
// this phase's task brief). This is a minimal ambient declaration covering
// only the surface claims.ts actually uses.
declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
    windows?: boolean;
    basename?: boolean;
  }

  interface ScanResult {
    base: string;
    glob: string;
    isGlob: boolean;
  }

  interface Picomatch {
    (glob: string | string[], options?: PicomatchOptions): (input: string) => boolean;
    scan(glob: string, options?: PicomatchOptions): ScanResult;
  }

  const picomatch: Picomatch;
  export default picomatch;
}
