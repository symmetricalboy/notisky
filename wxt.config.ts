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
    // Explicitly define CSP to allow connections for OAuth
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https://*.bsky.social https://notisky.symm.app;",
      // sandbox: "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';" // If using sandbox
    },
    // Add explicit content scripts configuration
    content_scripts: [
      {
        matches: ['*://*.bsky.app/*'],
        js: ['content.js']
      }
    ]
  },
  // REMOVED define block for now
}); 