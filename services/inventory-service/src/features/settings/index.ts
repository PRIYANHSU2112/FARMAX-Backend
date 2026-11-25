// Public API of the settings feature. Other features import ONLY from here.
export { settingsModule } from './settings.module.js';
export type { SettingsService, StockWritesMode } from './settings.service.js';
export type { InventorySettings } from './settings.types.js';
export { ADMIN_SETTINGS_TAG } from './settings.docs.js';
export { SETTING_RULES } from './settings.validation.js';
