import BskyAgent from '@atproto/api';
import { Account, loadAccounts, saveAccount, refreshToken, removeAccount } from '../src/services/auth';
import { 
  startNotificationPolling, 
  stopNotificationPolling, 
  updateNotificationBadge,
  resetNotificationCount 
} from '../src/services/notifications';

// Store for authenticated accounts AND their agent instances
let activeAgents: Record<string, BskyAgent> = {};
// Store polling intervals
const pollingIntervals: Record<string, number> = {};

// Function to attempt resuming session or refreshing token for an account
async function activateAccountSession(account: Account): Promise<BskyAgent | null> {
    console.log(`Activating session for ${account.handle} (${account.did})`);
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    try {
        await agent.resumeSession({
            accessJwt: account.accessJwt,
            refreshJwt: account.refreshJwt,
            handle: account.handle,
            did: account.did
        });
        console.log(`Session resumed successfully for ${account.did}`);
        return agent;
    } catch (resumeError) {
        console.warn(`Failed to resume session for ${account.did}, attempting refresh...`, resumeError);
        const refreshedAccount = await refreshToken(account);
        if (refreshedAccount) {
            console.log(`Token refreshed for ${account.did}, attempting to resume again.`);
            const newAgent = new BskyAgent({ service: 'https://bsky.social' });
            try {
                await newAgent.resumeSession({
                    accessJwt: refreshedAccount.accessJwt,
                    refreshJwt: refreshedAccount.refreshJwt,
                    handle: refreshedAccount.handle,
                    did: refreshedAccount.did
                });
                console.log(`Session resumed successfully after refresh for ${refreshedAccount.did}`);
                return newAgent;
            } catch (resumeAfterRefreshError) {
                console.error(`FATAL: Failed to resume session even after successful token refresh for ${refreshedAccount.did}`, resumeAfterRefreshError);
                return null;
            }
        } else {
            console.error(`Token refresh failed for ${account.did}. Account needs re-login.`);
            return null;
        }
    }
}

// Start notification polling using an active agent
function startPollingForAccount(account: Account, agent: BskyAgent): void {
  if (!agent || !agent.session) {
      console.error(`Attempted to start polling for ${account.did} without a valid agent session.`);
      return;
  }
  if (pollingIntervals[account.did]) {
    console.log(`Stopping existing polling for ${account.did} before starting new one.`);
    stopNotificationPolling(pollingIntervals[account.did]);
  }
  
  pollingIntervals[account.did] = startNotificationPolling(account, agent);
  console.log(`Started polling for ${account.handle} (${account.did})`);
}

// Stop notification polling for an account
function stopPollingForAccount(did: string): void {
  if (pollingIntervals[did]) {
    stopNotificationPolling(pollingIntervals[did]);
    delete pollingIntervals[did];
    console.log(`Stopped polling for ${did}`);
  }
}

// Function to deactivate an account (stop polling, remove agent)
async function deactivateAccount(did: string): Promise<void> {
    console.log(`Deactivating account ${did}`);
    stopPollingForAccount(did);
    delete activeAgents[did];
    await removeAccount(did); // Remove from storage via auth service
    updateNotificationBadge(); // Removed argument
}

// Initialize all accounts, try to activate sessions, and start polling
async function initializeAccounts(): Promise<void> {
  console.log('Initializing accounts...');
  const loadedAccounts = await loadAccounts();
  activeAgents = {}; // Reset active agents map

  const activationPromises = Object.values(loadedAccounts).map(async (account) => {
    // Validate account structure before attempting activation
    if (!account || !account.did || !account.handle || !account.accessJwt || !account.refreshJwt) {
        console.warn('Skipping invalid account structure found during load:', account);
        return; // Skip this invalid account
    }
    const agent = await activateAccountSession(account);
    if (agent) {
      activeAgents[account.did] = agent;
      // Pass the original account object along with the activated agent
      startPollingForAccount(account, agent); 
    } else {
        console.warn(`Could not activate session for ${account.handle} (${account.did}). Needs re-authentication.`);
    }
  });

  await Promise.all(activationPromises);
  console.log(`Initialization complete. Active agents: ${Object.keys(activeAgents).length}`);
  updateNotificationBadge(); // Removed argument
}

export default defineBackground({
  main() {
    console.log('Notisky background service started', { id: browser.runtime.id });

    // Use callback style for getPermissionLevel
    browser.notifications.getPermissionLevel(level => {
      console.log('Notification permission level:', level);
    });

    // Setup message handlers for communication with popup and content script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('Background received message:', message.type, 'from', sender.url || sender.id);
      
      if (message.type === 'INITIATE_LOGIN') {
        console.log('INITIATE_LOGIN message received. Acknowledged. UI should handle login flow.');
        sendResponse({ success: true, message: 'Acknowledged. UI initiates login.' });
        return false; 
      }

      if (message.type === 'ACCOUNT_ADDED') {
          const { account } = message.data || {};
          if (account && account.did) {
              console.log(`ACCOUNT_ADDED message received for ${account.handle} (${account.did})`);
              saveAccount(account).then(async () => {
                  const agent = await activateAccountSession(account);
                  if (agent) {
                      activeAgents[account.did] = agent;
                      startPollingForAccount(account, agent); // Use updated signature
                      updateNotificationBadge(); // Removed argument
                      sendResponse({ success: true });
                  } else {
                      console.error(`Failed to activate session for newly added account ${account.did}`);
                      sendResponse({ success: false, error: 'Failed to activate session after login.' });
                  }
              }).catch(err => {
                  console.error('Error saving new account', err);
                  sendResponse({ success: false, error: 'Failed to save account.' });
              });
              return true; // Indicate async response
          } else {
              console.error('ACCOUNT_ADDED message received with invalid account data', message.data);
              sendResponse({ success: false, error: 'Invalid account data received.' });
              return false;
          }
      }
      
      if (message.type === 'GET_ACCOUNTS') {
        console.log('GET_ACCOUNTS request received');
        // Map active agents to simplified account info for UI
        const accountList = Object.values(activeAgents).map(agent => ({ 
            did: agent.session?.did, 
            handle: agent.session?.handle,
        })).filter(acc => acc.did && acc.handle); // Ensure agent session is valid
        console.log('Returning accounts:', accountList);
        sendResponse({ accounts: accountList });
        return false; 
      }
      
      if (message.type === 'NOTIFICATION_VIEW') {
        const { did } = message.data || {};
        console.log(`NOTIFICATION_VIEW received for ${did}`);
        if (did && activeAgents[did]) {
          resetNotificationCount(did);
          sendResponse({ success: true });
        } else {
          console.warn(`NOTIFICATION_VIEW: Active agent/account not found for ${did}`);
          sendResponse({ success: false, error: 'Active agent/account not found' });
        }
        return false;
      }
      
      if (message.type === 'REMOVE_ACCOUNT') {
        const { did } = message.data || {};
        console.log(`REMOVE_ACCOUNT request for ${did}`);
        if (did) {
          deactivateAccount(did)
            .then(() => sendResponse({ success: true }))
            .catch(err => {
                console.error('Error during account deactivation', err);
                sendResponse({ success: false, error: 'Failed to remove account' });
            });
          return true; // Indicate async response
        } else {
          console.error('REMOVE_ACCOUNT request missing DID');
          sendResponse({ success: false, error: 'DID is required for removal' });
          // Return false here, no async operation needed
          return false; 
        }
      }
      
      if (message.type === 'GET_AUTH_STATUS') {
          console.log('GET_AUTH_STATUS request received');
          const isAuthenticated = Object.keys(activeAgents).length > 0;
          console.log('Auth status:', isAuthenticated);
          sendResponse({ isAuthenticated });
          return false;
      }
      
      console.warn('Unhandled message type in background:', message.type);
      return false; 
    });

    // Setup notification click handler
    browser.notifications.onClicked.addListener((notificationId) => {
      console.log(`Notification clicked: ${notificationId}`);
      browser.tabs.create({ url: 'https://bsky.app/notifications' });
      browser.notifications.clear(notificationId);
    });

    // COMMENTED OUT storage listener - needs careful implementation if required
    /* browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.accounts) {
        console.log('Storage changed detected for accounts - Re-initialization needed?');
        // Potentially complex logic here to diff changes and update activeAgents/polling
        // initializeAccounts(); // Avoid simple re-init, could cause issues
      }
    }); */

    // Initialize accounts when the extension starts
    initializeAccounts();
  }
});
