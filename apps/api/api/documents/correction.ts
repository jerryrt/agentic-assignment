/**
 * Vercel entry point for /api/documents/correction.
 *
 * The handler itself lives in src/routes and is bundled into
 * generated/documents-correction.js by this package's build. Only that bundle
 * is imported here, and deliberately: Vercel's zero-config builder transpiles
 * this file and leaves its imports to resolve at run time, and a workspace
 * package consumed as TypeScript source through pnpm's symlinked
 * node_modules cannot be resolved there. The bundle is a real file inside
 * this directory tree with nothing left to resolve.
 */
export { POST } from '../../generated/documents-correction.js';
