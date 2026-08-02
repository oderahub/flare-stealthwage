import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // The shared protocol module (terms encoding, digests, rate maths) lives at
    // ../typescript/src/shared/protocol.ts — inside the FCC extension, because
    // that project compiles with rootDir="src" for the reproducible TEE image
    // and cannot import from outside it.
    //
    // Turbopack refuses to resolve imports above its project root, so widen the
    // root to the directory containing BOTH frontend/ and typescript/. Without
    // this the build fails with "Module not found: Can't resolve '@protocol'"
    // even though the tsconfig path alias is correct.
    root: path.join(process.cwd(), ".."),
  },
};

export default nextConfig;
