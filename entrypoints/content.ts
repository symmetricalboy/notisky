interface Account {
  did: string;
  handle: string;
  count: number;
}

// Store for notification counts by account
let accountNotifications: Record<string, Account> = {};
// Current active account DID
let currentAccountDid: string | null = null;

// Update the favicon with notification count
function updateFavicon(count: number): void {
  const existingFavicon = document.querySelector('link[rel="icon"]');
  if (!existingFavicon) return;
  
  // Only update if count > 0
  if (count <= 0) return;
  
  // Create canvas and draw notification badge
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  // Create image from existing favicon
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = existingFavicon.getAttribute('href') || '';
  
  img.onload = () => {
    // Draw the favicon
    ctx.drawImage(img, 0, 0, 32, 32);
    
    // Draw badge background
    ctx.beginPath();
    ctx.arc(24, 8, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#0085ff';
    ctx.fill();
    
    // Draw text
    ctx.fillStyle = 'white';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count.toString(), 24, 8);
    
    // Update favicon
    const newFavicon = document.createElement('link');
    newFavicon.rel = 'icon';
    newFavicon.href = canvas.toDataURL('image/png');
    
    // Replace old favicon
    document.head.removeChild(existingFavicon);
    document.head.appendChild(newFavicon);
  };
}

// Update notification badge in the UI
function updateNotificationBadge(): void {
  // Calculate total notifications for all accounts
  const totalCount = Object.values(accountNotifications).reduce(
    (sum, account) => sum + account.count, 0
  );
  
  // Update the favicon
  updateFavicon(totalCount);
  
  // Update the UI notification badge for the current account
  if (currentAccountDid) {
    const currentAccount = accountNotifications[currentAccountDid];
    if (currentAccount) {
      updateAccountNotificationBadge(currentAccount.count);
    }
  }
  
  // Update the cross-account badge
  updateCrossAccountBadge(totalCount);
}

// Update the notification badge for the currently active account
function updateAccountNotificationBadge(count: number): void {
  // Find notification tab badge
  const notificationTab = document.querySelector('a[href="/notifications"]');
  if (!notificationTab) return;
  
  // Look for existing badge or create one
  let badge = notificationTab.querySelector('.notisky-badge');
  
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notisky-badge';
      badge.style.backgroundColor = '#0085ff';
      badge.style.color = 'white';
      badge.style.borderRadius = '10px';
      badge.style.padding = '1px 6px';
      badge.style.fontSize = '12px';
      badge.style.fontWeight = 'bold';
      badge.style.marginLeft = '5px';
      notificationTab.appendChild(badge);
    }
    
    badge.textContent = count.toString();
  } else if (badge) {
    badge.remove();
  }
}

// Add a badge to the account switcher showing total notifications across accounts
function updateCrossAccountBadge(totalCount: number): void {
  // Find the account switcher button
  const accountSwitcher = document.querySelector('button[aria-label="Account menu"]');
  if (!accountSwitcher) return;
  
  // Look for existing badge or create one
  let badge = accountSwitcher.querySelector('.notisky-cross-account-badge');
  
  if (totalCount > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notisky-cross-account-badge';
      badge.style.position = 'absolute';
      badge.style.top = '-5px';
      badge.style.right = '-5px';
      badge.style.backgroundColor = '#0085ff';
      badge.style.color = 'white';
      badge.style.borderRadius = '10px';
      badge.style.padding = '1px 6px';
      badge.style.fontSize = '12px';
      badge.style.fontWeight = 'bold';
      
      // Make sure the account switcher is positioned relatively
      accountSwitcher.style.position = 'relative';
      accountSwitcher.appendChild(badge);
    }
    
    badge.textContent = totalCount.toString();
  } else if (badge) {
    badge.remove();
  }
}

// Detect when the user is viewing the notifications tab
function detectNotificationTabView(): void {
  // Check if we're on the notifications page
  if (window.location.pathname === '/notifications') {
    // Reset notification count for current account
    if (currentAccountDid) {
      browser.runtime.sendMessage({
        type: 'NOTIFICATION_VIEW',
        data: { did: currentAccountDid }
      });
      
      // Update local count to avoid flickering
      if (accountNotifications[currentAccountDid]) {
        accountNotifications[currentAccountDid].count = 0;
        updateNotificationBadge();
      }
    }
  }
}

// Extract the current user's DID from the page
function extractCurrentUserDid(): string | null {
  // This is a simplified approach - in reality, you'd need to use a more robust method
  // to extract the DID from the Bluesky app
  
  // Look for data attributes or other indicators
  const userMenu = document.querySelector('[data-testid="userMenuButton"]');
  if (userMenu) {
    const didAttr = userMenu.getAttribute('data-did');
    if (didAttr) return didAttr;
  }
  
  return null;
}

// Setup mutation observer to watch for dynamic content changes
function setupMutationObserver(): void {
  const observer = new MutationObserver((mutations) => {
    // Check for navigation changes
    const locationChanged = mutations.some(mutation => 
      mutation.target.nodeName === 'TITLE' || 
      (mutation.target.nodeName === 'A' && mutation.attributeName === 'aria-current')
    );
    
    if (locationChanged) {
      detectNotificationTabView();
    }
    
    // Check if user switched accounts
    const newDid = extractCurrentUserDid();
    if (newDid && newDid !== currentAccountDid) {
      currentAccountDid = newDid;
      updateNotificationBadge();
    }
  });
  
  // Observe the entire document for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current', 'data-did']
  });
}

export default defineContentScript({
  matches: ['*://*.bsky.app/*'],
  main() {
    console.log('Notisky content script running on Bluesky');
    
    // Extract current user DID on initial load
    currentAccountDid = extractCurrentUserDid();
    
    // Check if we're on the notifications page
    detectNotificationTabView();
    
    // Setup mutation observer for UI changes
    setupMutationObserver();
    
    // Listen for messages from the background service worker
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'NOTIFICATION_COUNT_UPDATED') {
        const { did, handle, count } = message.data;
        
        // Update our local state
        accountNotifications[did] = { did, handle, count };
        
        // Update the UI
        updateNotificationBadge();
      }
      
      if (message.type === 'RESET_NOTIFICATION_COUNT') {
        const { did } = message.data;
        
        // Update our local state
        if (accountNotifications[did]) {
          accountNotifications[did].count = 0;
          
          // Update the UI
          updateNotificationBadge();
        }
      }
    });
  },
});
