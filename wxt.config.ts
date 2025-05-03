import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Notisky',
    description: 'Real-time notifications for Bluesky',
    permissions: [
      'storage',
      'notifications',
      'alarms',
      'identity',
      'tabs',
      'scripting'
    ],
    host_permissions: [
      '*://*.bsky.app/*',
      '*://*.bsky.social/*',
      '*://*.notisky.symm.app/*'
    ],
    web_accessible_resources: [
      {
        resources: ['assets/*', 'public/*', 'client-metadata/*'],
        matches: ['*://*.bsky.app/*', '*://*.bsky.social/*']
      }
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https://*.bsky.social https://notisky.symm.app;",
    },
  },
}); 