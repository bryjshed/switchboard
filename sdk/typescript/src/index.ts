/**
 * Default entry point: the OpenFeature provider plus everything in `./core`.
 *
 * This module imports `@openfeature/server-sdk`, which is an OPTIONAL peer dependency. If you do
 * not have it installed, import `@switchboard/openfeature-provider/core` instead - the
 * {@link SwitchboardClient} there has identical evaluation behaviour and no dependencies.
 */
export * from './core.js';
export { SwitchboardProvider, toEvalContext, type SwitchboardProviderOptions } from './provider.js';
