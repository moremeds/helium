import type { OptionWizardRuntimeConfig } from "./schema.js";

export const OW_RUNTIME_DEFAULT: OptionWizardRuntimeConfig = Object.freeze({
  schemaVersion: "ow-runtime-v1",
  tenant: "option-wizard",
  phase: "premarket",
  config: Object.freeze({
    news: Object.freeze({ global: 4, perStock: 2, stocks: 5 }),
  }),
});
