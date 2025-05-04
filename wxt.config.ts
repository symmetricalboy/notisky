import { defineConfig } from 'wxt';
// import react from '@vitejs/plugin-react'; // Module handles React

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  
  manifest: {
    name: 'Notisky',
    description: 'Get real-time Bluesky notifications in your browser.',
    version: '0.1.0',
    permissions: [
        "storage", 
        "notifications", 
        "alarms",
        "identity", 
        "scripting" // Ensure scripting permission is present
    ],
    host_permissions: [
        "*://*.bsky.social/*", 
        "*://notisky.symm.app/*" // Ensure host permission is present
    ],
    // Add externally_connectable for the auth server
    externally_connectable: {
      matches: [
        "https://notisky.symm.app/*"
      ]
    },
    background: {
        service_worker: "entrypoints/background.ts"
    },
    action: {
        default_popup: "entrypoints/popup/index.html"
    },
    options_page: "entrypoints/options/index.html",
    // Enable content scripts for auth finalization
    content_scripts: [
        {
            matches: ["*://notisky.symm.app/auth-finalize.html*"],
            js: ["public/auth-finalize-cs.js"],
            run_at: "document_idle"
        }
    ]
  },
}); 