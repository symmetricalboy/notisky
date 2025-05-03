import AtprotoAPI from '@atproto/api';
const { BskyAgent } = AtprotoAPI;
// @ts-ignore - Type import issues with @atproto/api structure
const { AtpSessionEvent, AppBskyNotificationListNotifications } = AtprotoAPI;

import { Account } from './auth';

// Store for notification counts per account
const notificationCounts: Record<string, number> = {};

// Store for last notification timestamp per account
const lastNotificationTimestamps: Record<string, string> = {};

// Default polling interval (1000ms)
const DEFAULT_POLLING_INTERVAL = 1000;

/**
 * Create a new BskyAgent instance for an account
 */
function createAgentForAccount(account: Account): any {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  
  // Resume the session with stored tokens
  agent.resumeSession({
    refreshJwt: account.refreshJwt,
    accessJwt: account.accessJwt,
    did: account.did,
    handle: account.handle
  });
  
  // Handle session events
  // @ts-ignore - Method resolution issue
  agent.addEventListener(AtpSessionEvent.Create, () => {
    console.log('Session created for', account.handle);
  });
  
  // @ts-ignore - Method resolution issue
  agent.addEventListener(AtpSessionEvent.Update, () => {
    console.log('Session updated for', account.handle);
    // TODO: Update the stored account with new tokens
  });
  
  // @ts-ignore - Method resolution issue
  agent.addEventListener(AtpSessionEvent.Expired, () => {
    console.log('Session expired for', account.handle);
    // TODO: Handle expired session
  });
  
  return agent;
}

/**
 * Start polling for notifications for an account
 */
export function startNotificationPolling(account: Account, interval = DEFAULT_POLLING_INTERVAL): number {
  const agent = createAgentForAccount(account);
  
  // Initial fetch to get current count
  fetchNotifications(agent, account);
  
  // Set up interval for regular polling
  const intervalId = window.setInterval(() => {
    fetchNotifications(agent, account);
  }, interval);
  
  return intervalId;
}

/**
 * Stop polling for an account
 */
export function stopNotificationPolling(did: string, pollingIntervals: Record<string, number>): void {
  const intervalId = pollingIntervals[did];
  if (intervalId) {
    window.clearInterval(intervalId);
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
  agent: any, 
  account: Account
): Promise<void> {
  try {
    // Get the last notification timestamp
    const lastSeenAt = lastNotificationTimestamps[account.did] || undefined;
    
    // Fetch notifications
    const response = await agent.listNotifications({
      limit: 20,
      seenAt: lastSeenAt
    });
    
    // Get only unread notifications
    const unreadNotifications = response.data.notifications.filter(
      // @ts-ignore - Namespace resolution issue
      (notification: AppBskyNotificationListNotifications.Notification) => !notification.isRead
    );
    
    // Store the current notification count
    const previousCount = notificationCounts[account.did] || 0;
    const currentCount = unreadNotifications.length;
    notificationCounts[account.did] = currentCount;
    
    // Check if we have new notifications
    if (currentCount > previousCount && previousCount !== 0) {
      // Get the new notifications (ones we haven't processed yet)
      const newNotifications = unreadNotifications.slice(0, currentCount - previousCount);
      
      // Process new notifications
      processNewNotifications(newNotifications, account);
    }
    
    // Update seen timestamp if there are any notifications
    if (response.data.notifications.length > 0) {
      lastNotificationTimestamps[account.did] = new Date().toISOString();
    }
    
    // Send message to update the UI
    browser.runtime.sendMessage({
      type: 'NOTIFICATION_COUNT_UPDATED',
      data: {
        did: account.did,
        handle: account.handle,
        count: currentCount
      }
    });
    
  } catch (error) {
    console.error('Error fetching notifications for', account.handle, error);
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