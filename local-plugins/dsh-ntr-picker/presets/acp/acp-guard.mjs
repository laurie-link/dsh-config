/**
 * Compatibility entry point. Keep the implementation in a fresh module so
 * desktop hosts that cached the previous global guard can hot-load the fix.
 */
export * from './acp-guard-isolated.mjs'
