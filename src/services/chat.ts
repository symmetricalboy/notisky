import AtprotoAPI from '@atproto/api';
import { Account } from './auth';
import { agentFetchWithDpop } from '../../entrypoints/background'; // Import DPoP fetch

const { BskyAgent } = AtprotoAPI;

// Store for unread message counts per account
const messageCounts: Record<string, number> = {};
// Store the map reference here, it will be passed in from background
let chatPollingIntervalsRef: Record<string, number> | null = null; 

// Default polling interval (e.g., every 60 seconds - chat might be less frequent than notifs)
const DEFAULT_CHAT_POLLING_INTERVAL = 60000; 

/**
 * Start polling for chat updates for an account
 */
export function startChatPolling(
  account: Account,
  chatPollingIntervals: Record<string, number> // Accept the map here
): number {
  // Store the reference to the map for use in fetchChatUpdates
  if (!chatPollingIntervalsRef) {
      chatPollingIntervalsRef = chatPollingIntervals;
  }

  console.log(`[Chat] Starting polling for ${account.handle}`);
  // Initial fetch - pass the map
  fetchChatUpdates(account, chatPollingIntervals);

  // Set up interval using the default constant
  const intervalId = setInterval(() => {
    // Pass the map on subsequent calls
    fetchChatUpdates(account, chatPollingIntervals); 
  }, DEFAULT_CHAT_POLLING_INTERVAL); // Use constant directly

  console.log(`[Chat] Polling interval ${intervalId} started for ${account.did}`);
  // Store the intervalId in the map passed from background
  chatPollingIntervals[account.did] = intervalId;
  return intervalId;
}

/**
 * Stop polling for chat updates
 */
export function stopChatPolling(did: string, chatPollingIntervals: Record<string, number>): void {
  const intervalId = chatPollingIntervals[did];
  if (intervalId) {
    clearInterval(intervalId);
    delete chatPollingIntervals[did];
    console.log(`[Chat] Stopped polling for ${did}`);
  } else {
    console.warn(`[Chat] No active polling interval found for ${did} to stop.`);
  }
}

/**
 * Stop polling for ALL accounts
 */
export function stopAllChatPolling(chatPollingIntervals: Record<string, number>): void {
  console.log('[Chat] Stopping polling for all accounts...');
  Object.keys(chatPollingIntervals).forEach(did => {
    stopChatPolling(did, chatPollingIntervals);
  });
  console.log('[Chat] Finished stopping all chat polling.');
}

/**
 * Fetch chat updates (listConvos) for an account
 */
async function fetchChatUpdates(
    account: Account, 
    chatPollingIntervals: Record<string, number> // Accept map here
): Promise<void> {
  console.log(`[Chat] Fetching updates for ${account.handle}`);
  try {
    // Construct the URL for listConvos
    const listConvosUrl = `${account.pdsUrl}/xrpc/app.bsky.chat.bsky.convo.listConvos`;
    console.log(`[Chat] Manually fetching URL: ${listConvosUrl}`);

    // Bind the DPoP fetch function
    const boundFetch = agentFetchWithDpop.bind(account);

    // Make the request
    const response = await boundFetch(listConvosUrl, { 
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
        // --- Handle 501 Not Implemented specifically ---
        if (response.status === 501) {
            console.warn(`[Chat] Endpoint app.bsky.chat.bsky.convo.listConvos not implemented on PDS ${account.pdsUrl} for account ${account.handle}. Permanently stopping chat polling for this account.`);
            // Permanently stop polling for chat for this specific account
            stopChatPolling(account.did, chatPollingIntervals); // Use the passed map
            messageCounts[account.did] = 0; // Assume 0 unread if endpoint missing
            // Send update if count changed to 0
            // Check previous value - careful not to access potentially deleted key
            const previousCount = messageCounts[account.did] || 0; 
            if (0 !== previousCount) { 
                 browser.runtime.sendMessage({ type: 'MESSAGE_COUNT_UPDATED', data: { did: account.did, count: 0 } }).catch(()=>{});
            }
            return; // Stop further processing for this fetch
        }
        // -----------------------------------------------
        const errorText = await response.text();
        throw new Error(`[Chat] Fetch failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Assuming the response structure matches app.bsky.chat.bsky.convo.listConvos
    // Needs proper typing if available, using 'any' for now
    const responseData: any = await response.json(); 

    let currentUnreadCount = 0;
    if (responseData.convos && Array.isArray(responseData.convos)) {
        // Calculate total unread count from all conversations
        currentUnreadCount = responseData.convos.reduce((sum: number, convo: any) => {
            // Check if convo exists and has an unreadCount property which is a number
            if (convo && typeof convo.unreadCount === 'number' && convo.unreadCount > 0) {
                return sum + convo.unreadCount;
            }
            return sum;
        }, 0);
    }

    const previousCount = messageCounts[account.did] || 0;
    messageCounts[account.did] = currentUnreadCount;

    console.log(`[Chat] Fetched for ${account.handle}. Unread: ${currentUnreadCount}, Previous: ${previousCount}`);

    // If count changed, send an update message
    if (currentUnreadCount !== previousCount) {
        console.log(`[Chat] Unread count changed for ${account.handle}. Sending update.`);
        browser.runtime.sendMessage({
            type: 'MESSAGE_COUNT_UPDATED',
            data: {
                did: account.did,
                count: currentUnreadCount
            }
        }).catch(err => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.warn(`[Chat] Error sending MESSAGE_COUNT_UPDATED message: ${errorMessage}`);
        });
    }

  } catch (error) {
    console.error(`[Chat] Error fetching chat updates for ${account.handle} (${account.did}):`, error);
  }
}

/**
 * Get the total unread message count across all accounts
 */
export function getTotalMessageCount(): number {
  return Object.values(messageCounts).reduce((sum, count) => sum + count, 0);
}

/**
 * Get unread message count for a specific account
 */
export function getMessageCountForAccount(did: string): number {
  return messageCounts[did] || 0;
} 