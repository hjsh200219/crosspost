#!/usr/bin/env node
// Generic workflow entrypoint. The implementation keeps its historical filename
// for direct callers, while /publish can use scripts/<channel>/post-api.mjs.
await import('./remember-post.mjs');
