// Preloaded with NODE_OPTIONS=--import for projects that load their tests as ES modules.
import { register } from 'node:module';
register('./esm-hooks.mjs', import.meta.url);
