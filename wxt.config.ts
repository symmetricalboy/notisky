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
      'tabs'
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
  },
  // Add explicit content scripts configuration
  contentScripts: {
    entries: {
      content: {
        matches: ['*://*.bsky.app/*'],
        js: ['entrypoints/content.ts']
      }
    }
  },
  // Add DPoP configuration
  define: {
    'process.env.DOP_ENABLED': JSON.stringify(true),
  }
}); 