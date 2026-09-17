import base from './playwright.config.mjs';
export default { ...base, globalSetup: undefined, testMatch: ['**/web-app.spec.mjs'] };
