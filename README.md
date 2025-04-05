# Notisky - Real-time Bluesky Notifications

![Notisky Logo](public/icon/128.png)

Notisky is a browser extension that enhances the Bluesky experience by providing real-time notifications, multi-account support, and improved UI features.

## Features

- **Multi-Account Support**: Manage and receive notifications from multiple Bluesky accounts simultaneously
- **Real-Time Notifications**: Get instant desktop notifications whenever something happens on your Bluesky account
- **Badge Counters**: See notification counts directly on the extension icon and Bluesky favicon
- **Secure OAuth Authentication**: Authenticate securely using Bluesky's official OAuth flow

## Installation

### From Releases

1. Download the latest version from the [Releases](https://github.com/symmetricalboy/notisky/releases) page
2. In Chrome, go to `chrome://extensions/` and enable "Developer mode"
3. Drag the downloaded ZIP file into the Chrome extensions page or click "Load unpacked" and select the extracted folder
4. Click the Notisky icon in your browser toolbar and log in with your Bluesky account

### From Source

1. Clone this repository
2. Install dependencies with `npm install`
3. Build the extension with `npm run build`
4. Load the extension from the `.output/chrome-mv3` directory using Chrome's developer mode

## Development

```bash
# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Build for production
npm run build

# Create zip file for distribution
npm run zip
```

## Project Structure

- `entrypoints/`: Contains the entry points for the extension
  - `background.ts`: The background service worker
  - `content.ts`: The content script that modifies the Bluesky UI
  - `popup/`: The popup UI for the extension
  - `options/`: The options page for configuring the extension
  - `login/`: Login-related UI components
- `src/`: Contains the source code for the extension
  - `services/`: Contains shared services used by different parts of the extension
    - `auth.ts`: Authentication service
    - `notifications.ts`: Notification service
    - `atproto-oauth.ts`: Bluesky OAuth implementation
- `public/`: Contains public assets
  - `icon/`: Extension icons
  - `client-metadata/`: OAuth client metadata

## Roadmap

See the [ROADMAP.md](ROADMAP.md) file for detailed development plans.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE)

## Acknowledgements

- Built with [WXT](https://wxt.dev/)
- Uses [Bluesky's OAuth](https://docs.bsky.app/blog/oauth-atproto) implementation 