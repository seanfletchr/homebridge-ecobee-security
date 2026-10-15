import { EcobeeSecurityPlatform, PLATFORM_NAME } from './lib/platform.js';

export default (api) => {
  api.registerPlatform(PLATFORM_NAME, EcobeeSecurityPlatform);
};
