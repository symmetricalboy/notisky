import BskyAgent from '@atproto/api';
import { Account, loadAccounts, saveAccount, removeAccount } from '../src/services/auth';
import { 
  startNotificationPolling, 
  stopNotificationPolling, 
  updateNotificationBadge,
  resetNotificationCount,
  stopAllPolling
} from '../src/services/notifications';

// Constants for OAuth Token Exchange
const BLUESKY_SERVICE = 'https://bsky.social'; // Base service URL
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;
const CLIENT_METADATA_URL = 'https://notisky.symm.app/public/client-metadata/client.json'; // Our client ID
const WEB_CALLBACK_URL = 'https://notisky.symm.app/public/oauth-callback.html'; // Redirect URI used in flow

// Store for authenticated accounts AND their agent instances
let activeAgents: Record<string, BskyAgent> = {};
// Store polling intervals
const pollingIntervals: Record<string, number> = {};

// Function to attempt resuming session or refreshing token for an account
// NOTE: With OAuth, refreshing is handled by exchanging the refresh_token, not via resumeSession like password auth
// This function needs adjustment or replacement if using OAuth refresh tokens.
// For now, it just creates an agent with the initial tokens.
async function activateOAuthSession(account: Account): Promise<BskyAgent | null> {
    console.log(`Activating OAuth session for ${account.handle} (${account.did})`);
    if (!account.accessJwt || !account.refreshJwt) {
        console.error(`Account ${account.did} missing OAuth tokens.`);
        return null;
    }
    try {
        // Simply create an agent instance with the existing session data
        const agent = new BskyAgent({ 
            service: BLUESKY_SERVICE, 
            session: {
                did: account.did,
                handle: account.handle,
                email: account.email,
                accessJwt: account.accessJwt,
                refreshJwt: account.refreshJwt
            }
         });
        // Verify session is correctly initialized (optional but good practice)
        if (agent.session?.did !== account.did) {
            console.error(`Failed to initialize agent session correctly for ${account.did}`);
            return null;
        }
        console.log(`Agent created for ${account.did}`);
        return agent;
    } catch (error) {
        console.error(`Error creating agent for ${account.did}:`, error);
        return null;
    }
}

// Start notification polling using an active agent
function startPollingForAccount(account: Account, agent: BskyAgent): void {
  if (!agent || !agent.session) {
      console.error(`Attempted to start polling for ${account.did} without a valid agent session.`);
      return;
  }
  stopNotificationPolling(account.did, pollingIntervals); // Clear existing interval if any
  startNotificationPolling(account, agent, pollingIntervals); 
}

// Stop notification polling for an account
function stopPollingForAccount(did: string): void {
  if (pollingIntervals[did]) {
    stopNotificationPolling(did, pollingIntervals);
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
  const accounts = await loadAccounts();
  console.log('Accounts loaded from storage:', accounts);
  activeAgents = {}; // Clear existing agents
  stopAllPolling(pollingIntervals);

  for (const account of accounts) {
      // Use activateOAuthSession for OAuth accounts
      const agent = await activateOAuthSession(account);
      if (agent) {
          activeAgents[account.did] = agent;
          startPollingForAccount(account, agent);
      }
  }
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
      console.log('Background received message:', message.type, 'from', sender.tab?.url || sender.url || sender.id);
      
      if (message.type === 'INITIATE_LOGIN') {
        console.log('INITIATE_LOGIN message received. Acknowledged. UI should handle login flow.');
        sendResponse({ success: true, message: 'Acknowledged. UI initiates login.' });
        return false; 
      }

      if (message.type === 'EXCHANGE_OAUTH_CODE') {
        // Immediately return true to indicate async response
        sendResponse(); 
        const { code, state, verifierStorageKey } = message.data;

        (async () => {
            let success = false;
            let errorMsg = 'Unknown error during token exchange.';
            try {
                console.log(`[TokenExchange] Received code for state: ${state}`);
                if (!verifierStorageKey || !code) {
                    throw new Error('Missing code or verifier key.');
                }
                const codeVerifier = localStorage.getItem(verifierStorageKey);
                localStorage.removeItem(verifierStorageKey); // Clean up immediately

                if (!codeVerifier) {
                    throw new Error(`PKCE Verifier not found for key: ${verifierStorageKey}`);
                }
                console.log('[TokenExchange] Retrieved PKCE verifier.');

                const tokenParams = new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: WEB_CALLBACK_URL,
                    client_id: CLIENT_METADATA_URL,
                    code_verifier: codeVerifier
                });

                console.log('[TokenExchange] Sending request to:', TOKEN_ENDPOINT);
                const response = await fetch(TOKEN_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: tokenParams.toString()
                });

                console.log(`[TokenExchange] Response status: ${response.status}`);
                const tokenData = await response.json();

                if (!response.ok) {
                    errorMsg = `Token exchange failed: ${tokenData.error || response.statusText}`;
                    console.error('[TokenExchange] Error response:', tokenData);
                    throw new Error(errorMsg);
                }

                console.log('[TokenExchange] Token data received:', tokenData);

                // Basic validation of expected token data
                if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.did || !tokenData.handle) {
                    errorMsg = 'Incomplete token data received from server.';
                    console.error('[TokenExchange] Incomplete data:', tokenData);
                    throw new Error(errorMsg);
                }

                // Create Account object
                const newAccount: Account = {
                    did: tokenData.did,
                    handle: tokenData.handle,
                    accessJwt: tokenData.access_token,
                    refreshJwt: tokenData.refresh_token,
                    email: tokenData.email || undefined // Email might not always be present
                };

                console.log('[TokenExchange] Account created:', newAccount.handle);
                
                // Save account and activate session
                await saveAccount(newAccount);
                const agent = await activateOAuthSession(newAccount);
                if (agent) {
                    activeAgents[newAccount.did] = agent;
                    startPollingForAccount(newAccount, agent);
                    success = true;
                    console.log('[TokenExchange] Account saved and activated.');
                } else {
                     errorMsg = 'Failed to activate session after token exchange.';
                     throw new Error(errorMsg);
                }

            } catch (error: any) {
                console.error('[TokenExchange] Error:', error);
                errorMsg = error.message || errorMsg;
                success = false;
                // Attempt cleanup again just in case
                if (verifierStorageKey) localStorage.removeItem(verifierStorageKey);
            } finally {
                 // Send response back to the popup/sender
                 console.log(`[TokenExchange] Sending response: success=${success}, error=${errorMsg}`);
                 // Need to use chrome.tabs.sendMessage for Manifest V3 if sender.tab exists
                 if (sender.tab?.id) {
                     browser.tabs.sendMessage(sender.tab.id, { 
                         type: 'EXCHANGE_OAUTH_CODE_RESULT', // Use a different type for the response
                         success: success, 
                         error: success ? undefined : errorMsg 
                     });
                 } else {
                     console.warn('[TokenExchange] Could not determine sender tab ID to send response.');
                     // Fallback or alternative if needed, e.g., storing result and having popup poll?
                 }
            }
        })();
        
        return true; // Indicate async handling (though sendResponse was called earlier)
      }
      
      if (message.type === 'ACCOUNT_ADDED') {
          const { account } = message.data || {};
          if (account && account.did) {
              console.log(`ACCOUNT_ADDED message received for ${account.handle} (${account.did})`);
              saveAccount(account).then(async () => {
                  const agent = await activateOAuthSession(account);
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
        const { viewDid } = message.data || {};
        console.log(`NOTIFICATION_VIEW received for ${viewDid}`);
        if (viewDid && activeAgents[viewDid]) {
          resetNotificationCount(viewDid);
          sendResponse({ success: true });
        } else {
          console.warn(`NOTIFICATION_VIEW: Active agent/account not found for ${viewDid}`);
          sendResponse({ success: false, error: 'Active agent/account not found' });
        }
        return false;
      }
      
      if (message.type === 'REMOVE_ACCOUNT') {
        const { removeDid } = message.data || {};
        console.log(`REMOVE_ACCOUNT request for ${removeDid}`);
        if (removeDid) {
          deactivateAccount(removeDid)
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
