import AtprotoAPI from '@atproto/api';
const { BskyAgent } = AtprotoAPI;
// @ts-ignore - Type import issues with @atproto/api structure
const { AtpSessionEvent, AppBskyNotificationListNotifications } = AtprotoAPI;

import { Account } from './auth';
// Import the DPoP fetch function and Account type from background
// Adjust path as necessary based on file structure
import { agentFetchWithDpop } from '../../entrypoints/background';

// Define a clearer type for notifications for internal use
type Notification = AtprotoAPI.AppBskyNotificationListNotifications.Notification;

// Store for notification counts per account
const notificationCounts: Record<string, number> = {};

// Store for recent notifications per account (capped)
const recentNotifications: Record<string, Notification[]> = {};
const MAX_RECENT_NOTIFICATIONS = 10; // Keep the last 10 notifications

// Default polling interval (1000ms)
const DEFAULT_POLLING_INTERVAL = 1000;

/**
 * Start polling for notifications for an account
 */
export function startNotificationPolling(
  account: Account, 
  agent: BskyAgent // Accept the full agent again
): number {
  
  console.log(`[Notifications] Starting polling for ${account.handle} using agent`);
  // Initial fetch 
  fetchNotifications(account, agent); // Pass account and agent
  
  // Set up interval for regular polling using the default constant
  const intervalId = setInterval(() => {
    fetchNotifications(account, agent); // Pass account and agent
  }, DEFAULT_POLLING_INTERVAL); // Use constant directly
  
  console.log(`[Notifications] Polling interval ${intervalId} started for ${account.did}`);
  return intervalId;
}

/**
 * Stop polling for an account
 */
export function stopNotificationPolling(did: string, pollingIntervals: Record<string, number>): void {
  const intervalId = pollingIntervals[did];
  if (intervalId) {
    clearInterval(intervalId); // Use global clearInterval
    delete pollingIntervals[did]; // Remove from the record
    console.log(`Stopped polling for ${did}`);
  } else {
    console.warn(`No active polling interval found for ${did} to stop.`);
  }
}

/**
 * Stop polling for ALL accounts
 */
export function stopAllPolling(pollingIntervals: Record<string, number>): void {
  console.log('Stopping polling for all accounts...');
  Object.keys(pollingIntervals).forEach(did => {
    stopNotificationPolling(did, pollingIntervals); // Reuse the single-stop function
  });
  console.log('Finished stopping all polling.');
}

/**
 * Fetch notifications for an account and process new ones
 */
async function fetchNotifications(
  account: Account,       // Need account for tokens/keys/PDS
  agent: BskyAgent        // Keep agent for potential fallback or future use? (optional now)
): Promise<void> {
  
  try {
    // Construct parameters and URL for manual fetch - WITHOUT seenAt
    const params = new URLSearchParams({
        limit: '50' // URLSearchParams needs string values
    });

    console.log(`[Notifications] Fetching for ${account.handle} via agent (no seenAt):`, params);
    
    // Construct the full URL for the XRPC endpoint
    const listNotificationsUrl = `${account.pdsUrl}/xrpc/app.bsky.notification.listNotifications?${params.toString()}`;
    console.log(`[Notifications] Manually fetching URL: ${listNotificationsUrl}`);

    // Bind the DPoP fetch function to the account's context
    const boundFetch = agentFetchWithDpop.bind(account);

    // Make the request using the imported DPoP fetch function
    const response = await boundFetch(listNotificationsUrl, { 
        method: 'GET', 
        headers: { 
            // agentFetchWithDpop handles Authorization and DPoP headers 
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fetch failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Parse the JSON response body
    const responseData: AtprotoAPI.AppBskyNotificationListNotifications.OutputSchema = await response.json(); 
    
    // --- Store Recent Notifications --- 
    if (responseData.notifications && responseData.notifications.length > 0) {
        if (!recentNotifications[account.did]) {
            recentNotifications[account.did] = [];
        }
        // Add new notifications to the beginning and slice to keep the max count
        recentNotifications[account.did] = [
            ...responseData.notifications, 
            ...recentNotifications[account.did]
        ].slice(0, MAX_RECENT_NOTIFICATIONS);
        // Consider filtering duplicates if necessary, but assuming listNotifications is chronological
    }
    // ---------------------------------

    // Get only unread notifications
    const unreadNotifications = responseData.notifications.filter(
      (notification: Notification) => !notification.isRead 
    );
    
    // Store the current notification count
    const previousCount = notificationCounts[account.did] || 0;
    const currentCount = unreadNotifications.length;
    notificationCounts[account.did] = currentCount;
    
    console.log(`[Notifications] Fetched for ${account.handle}. Unread: ${currentCount}, Previous: ${previousCount}`);

    // Check if we have new notifications SINCE THE LAST CHECK (not just total unread)
    if (responseData.notifications.length > 0 && currentCount > 0) {
      // Find the actual new ones based on timestamp or unseen status if possible
      // For simplicity now, process all *currently* unread ones if count increased
      // A more robust way would involve comparing CIDs or timestamps if needed.
      if (currentCount > previousCount) {
          console.log(`[Notifications] New notifications detected for ${account.handle}. Processing ${currentCount - previousCount} new.`);
          // Process only the difference 
          // Note: This assumes notifications are ordered newest first
          const newlyUnread = unreadNotifications.slice(0, currentCount - previousCount);
          processNewNotifications(newlyUnread, account); 
      } else if (currentCount < previousCount) {
          // Count decreased, likely marked as read elsewhere. Log it.
          console.log(`[Notifications] Unread count decreased for ${account.handle} (Read elsewhere?).`);
      }

    } else {
      console.log(`[Notifications] No new unread notifications found for ${account.handle}`);
    }
    
    // Send message to update the UI (badge/popup)
    updateNotificationBadge(); // Update badge based on ALL counts
    browser.runtime.sendMessage({
      type: 'NOTIFICATION_COUNT_UPDATED',
      data: {
        did: account.did,
        handle: account.handle,
        count: currentCount // Send the current total unread count
      }
    }).catch(err => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`Error sending NOTIFICATION_COUNT_UPDATED message: ${errorMessage}`); 
    }); // Log error more reliably

  } catch (error) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      // Log specific ATProto error types if available
      // if (error instanceof AtprotoAPI.AtpError) { ... }
      errorMessage = error.message;
    }
    // Avoid logging full agent object in case of error
    console.error(`[Notifications] Error fetching notifications for ${account.handle} (${account.did}): ${errorMessage}`, error);
  }
}

/**
 * Process new notifications and create desktop notifications
 */
function processNewNotifications(
  // @ts-ignore - Namespace resolution issue
  notifications: AppBskyNotificationListNotifications.Notification[],
  account: Account
): void {
  notifications.forEach(notification => {
    // Determine notification title and content
    let title = `@${account.handle} - New ${notification.reason}`;
    let content = 'New notification from Bluesky';
    
    // Customize content based on notification type
    switch (notification.reason) {
      case 'like':
        content = `@${notification.author.handle} liked your post`;
        break;
      case 'repost':
        content = `@${notification.author.handle} reposted your post`;
        break;
      case 'follow':
        content = `@${notification.author.handle} followed you`;
        break;
      case 'mention':
        content = `@${notification.author.handle} mentioned you`;
        break;
      case 'reply':
        content = `@${notification.author.handle} replied to your post`;
        break;
      case 'quote':
        content = `@${notification.author.handle} quoted your post`;
        break;
    }
    
    // Create desktop notification
    browser.notifications.create({
      type: 'basic',
      iconUrl: notification.author.avatar || browser.runtime.getURL('public/icon/96.png'),
      title,
      message: content
    });
  });
}

/**
 * Get the total unread notification count across all accounts
 */
export function getTotalNotificationCount(): number {
  return Object.values(notificationCounts).reduce((sum, count) => sum + count, 0);
}

/**
 * Get unread notification count for a specific account
 */
export function getNotificationCountForAccount(did: string): number {
  return notificationCounts[did] || 0;
}

/**
 * Get recent notifications for a specific account
 */
export function getRecentNotificationsForAccount(did: string): Notification[] {
  return recentNotifications[did] || [];
}

/**
 * Update the notification badge with the current count
 */
export function updateNotificationBadge(): void {
  const totalCount = getTotalNotificationCount();
  
  if (totalCount > 0) {
    browser.action.setBadgeText({ text: totalCount.toString() });
    browser.action.setBadgeBackgroundColor({ color: '#0085ff' });
  } else {
    browser.action.setBadgeText({ text: '' });
  }
}

/**
 * Reset notification count for an account (e.g., when user views notifications)
 */
export function resetNotificationCount(did: string): void {
  notificationCounts[did] = 0;
  updateNotificationBadge();
  
  // Inform content script to update UI
  browser.tabs.query({ url: '*://*.bsky.app/*' }).then(tabs => {
    tabs.forEach(tab => {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, { 
          type: 'RESET_NOTIFICATION_COUNT',
          data: { did }
        });
      }
    });
  });
} 