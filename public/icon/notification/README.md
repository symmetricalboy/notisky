# Notisky Notification Badges

This directory contains pre-generated notification badges for the Notisky extension. Each badge is a standalone red circle with a white notification count in the center, designed to completely replace the extension icon when notifications are present.

## Badge Naming Convention

Badges follow a naming pattern of `{count}_{size}.png`:

- `count` ranges from 1 to 30, plus a special "30plus" for counts above 30
- `size` is one of: 16, 32, 48, or 128 pixels

For example:
- `1_16.png` - Badge showing 1 notification at 16x16 pixels
- `15_48.png` - Badge showing 15 notifications at 48x48 pixels
- `30plus_128.png` - Badge showing 30+ notifications at 128x128 pixels

## How It Works

The extension's background script (`background.ts`) uses these badges when displaying notification counts. It follows these rules:

1. When there are no notifications, it shows the regular Notisky bell icon
2. When there are notifications, it completely replaces the icon with the red badge showing the count
3. For counts 1-30, it uses the exact numbered badge (e.g., `5_16.png` for 5 notifications)
4. For counts above 30, it uses the "30plus" badge (e.g., `30plus_16.png`)
5. If a badge isn't found, it falls back to dynamic badge generation

This approach ensures that notification badges are clearly visible and don't clip at the edges of the icon space.

## Regenerating Badges

If you need to regenerate these badges:

1. Open `scripts/generate-notification-icons-browser.html` in your browser
2. Click "Generate All Badges"
3. Download the ZIP file with all generated badges
4. Replace the contents of this directory with the extracted badges

Alternatively, you can run the Node.js script:
```
node scripts/generate-notification-icons.mjs
``` 