import BskyAgent from '@atproto/api';
import { Account, loadAccounts, saveAccount, removeAccount, tokenResponseToAccount } from '../src/services/auth';
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
// Store PKCE verifiers during OAuth flow, keyed by state
const pkceVerifierStore: Record<string, string> = {}; // Use in-memory for now, consider browser.storage.session

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

// Store PKCE state temporarily (in-memory, suitable for Service Worker)
async function storePkceState(state: string, verifier: string): Promise<void> {
  pkceVerifierStore[state] = verifier;
  console.log(`[PKCE] Stored verifier for state: ${state.substring(0,5)}...`);
  // Optional: Add a timeout to clean up old states if needed
  setTimeout(() => {
    if (pkceVerifierStore[state]) {
      console.warn(`[PKCE] Cleaning up stale state: ${state.substring(0,5)}...`);
      delete pkceVerifierStore[state];
    }
  }, 5 * 60 * 1000); // Clean up after 5 minutes
}

// Retrieve and remove PKCE state
async function retrieveAndClearPkceState(state: string): Promise<string | null> {
  const verifier = pkceVerifierStore[state];
  if (verifier) {
    console.log(`[PKCE] Retrieved verifier for state: ${state.substring(0,5)}...`);
    delete pkceVerifierStore[state]; // Clear after retrieval
    return verifier;
  }
  console.error(`[PKCE] Verifier not found for state: ${state}`);
  return null;
}

// Initialize stored accounts on startup
async function initializeAccounts(): Promise<void> {
  console.log('Initializing accounts...');
  const accountsData = await loadAccounts(); // Returns Record<string, Account>
  console.log('Accounts data loaded from storage:', accountsData);
  activeAgents = {}; // Clear existing agents
  stopAllPolling(pollingIntervals);

  // Get the values (Account objects) from the loaded data
  const accountsList = Object.values(accountsData);
  console.log(`Found ${accountsList.length} accounts to initialize.`);

  // Iterate over the array of accounts
  for (const account of accountsList) {
      // Use activateOAuthSession for OAuth accounts
      const agent = await activateOAuthSession(account);
      if (agent) {
          activeAgents[account.did] = agent;
          startPollingForAccount(account, agent);
      } else {
          console.warn(`Failed to activate session for ${account.handle}. It might need re-authentication.`);
      }
  }
  console.log(`Initialization complete. Active agents: ${Object.keys(activeAgents).length}`);
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
      
      if (message.type === 'STORE_PKCE') {
        const { state, verifier } = message.data || {};
        if (state && verifier) {
          storePkceState(state, verifier)
            .then(() => sendResponse({ success: true }))
            .catch(err => {
              console.error('[STORE_PKCE] Error:', err);
              sendResponse({ success: false, error: err.message });
            });
          return true; // Indicate async response
        } else {
          console.error('[STORE_PKCE] Missing state or verifier in message data.');
          sendResponse({ success: false, error: 'Missing state or verifier' });
          return false;
        }
      }

      if (message.type === 'INITIATE_LOGIN') {
        console.log('INITIATE_LOGIN message received. Acknowledged. UI should handle login flow.');
        sendResponse({ success: true, message: 'Acknowledged. UI initiates login.' });
        return false; 
      }

      if (message.type === 'oauthCallback') {
        console.log('[OAuthCallback] Received callback from auth server page.');
        const { code, state } = message.data || {};

        if (!code || !state) {
          console.error('[OAuthCallback] Missing code or state in message data.');
          // Optionally send an error response back to the auth page if needed, though it might close itself
          sendResponse({ success: false, error: 'Missing code or state' });
          return false; // Indicate synchronous handling or end of processing here
        }

        // Indicate async handling
        sendResponse({ success: true, message: 'Processing callback...'});

        (async () => {
            let success = false;
            let errorMsg = 'Unknown error during token exchange.';
            let verifier: string | null = null;
            try {
                console.log(`[OAuthCallback] Received code for state: ${state}`);
                verifier = await retrieveAndClearPkceState(state);

                if (!verifier) {
                    throw new Error(`PKCE Verifier not found or expired for state: ${state}`);
                }
                console.log('[OAuthCallback] Retrieved PKCE verifier.');

                const tokenParams = new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    // IMPORTANT: Use the redirect_uri that the AUTH SERVER used
                    redirect_uri: 'https://notisky.symm.app/auth/extension-callback',
                    // Use the client_id that the AUTH SERVER used
                    client_id: CLIENT_METADATA_URL, // Defined at top of file
                    code_verifier: verifier
                });

                console.log('[OAuthCallback] Sending token exchange request to:', TOKEN_ENDPOINT);
                const response = await fetch(TOKEN_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: tokenParams.toString()
                });

                console.log(`[OAuthCallback] Token response status: ${response.status}`);
                const tokenData = await response.json();

                if (!response.ok) {
                    errorMsg = `Token exchange failed: ${tokenData.error || response.statusText} (${response.status})`;
                    console.error('[OAuthCallback] Error response:', tokenData);
                    throw new Error(errorMsg);
                }

                console.log('[OAuthCallback] Token data received successfully.');

                // Use tokenResponseToAccount to create the account object (handles profile fetch etc.)
                // Assuming tokenData contains access_token, refresh_token, did, scope etc.
                const newAccount = await tokenResponseToAccount(tokenData);

                if (!newAccount) {
                    errorMsg = 'Failed to process token response and create account object.';
                    console.error('[OAuthCallback] tokenResponseToAccount returned null.', tokenData);
                    throw new Error(errorMsg);
                }

                console.log('[OAuthCallback] Account created/parsed:', newAccount.handle);

                // Save account and activate session
                await saveAccount(newAccount);
                const agent = await activateOAuthSession(newAccount);
                if (agent) {
                    activeAgents[newAccount.did] = agent;
                    startPollingForAccount(newAccount, agent);
                    updateNotificationBadge(); // Update badge after successful login
                    success = true;
                    console.log('[OAuthCallback] Account saved and activated successfully.');
                } else {
                     errorMsg = 'Failed to activate agent session after token exchange.';
                     throw new Error(errorMsg);
                }

            } catch (error: any) {
                console.error('[OAuthCallback] Error during processing:', error);
                errorMsg = error.message || errorMsg;
                success = false;
                // Ensure PKCE state is cleared on error too
                if (state && !verifier) await retrieveAndClearPkceState(state);
            } finally {
                 // We might not have a reliable way to send a response back to the originating UI
                 // The auth server page tries to close itself. Log the final result here.
                 console.log(`[OAuthCallback] Processing finished. Success: ${success}. ${success ? '' : 'Error: ' + errorMsg}`);
                 // Send completion message back to any listening popups/UI
                 browser.runtime.sendMessage({
                   type: 'OAUTH_COMPLETE',
                   success: success,
                   error: success ? undefined : errorMsg
                 }).catch(err => {
                     // This might fail if no popup is open, which is okay.
                     console.log('[OAuthCallback] Could not send completion message (maybe no UI open?):', err.message);
                 });
            }
        })();

        return true; // Indicate async handling is underway
      }
      
      if (message.type === 'ACCOUNT_ADDED') {
          const { account } = message.data || {};
          if (account && account.did) {
              console.log(`ACCOUNT_ADDED message received for ${account.handle} (${account.did})`);
              // Indicate async handling
              sendResponse(); 
              (async () => {
                  let success = false;
                  let errorMsg = 'Failed to save or activate account.';
                  try {
                      await saveAccount(account);
                      const agent = await activateOAuthSession(account);
                      if (agent) {
                          activeAgents[account.did] = agent;
                          startPollingForAccount(account, agent); // Use updated signature
                          updateNotificationBadge(); // Removed argument
                          success = true;
                      } else {
                          console.error(`Failed to activate session for newly added account ${account.did}`);
                          errorMsg = 'Failed to activate session after login.';
                      }
                  } catch(err: any) {
                      console.error(`Error saving/activating newly added account ${account.did}:`, err);
                      errorMsg = err.message || errorMsg;
                  }
                  // Send completion message (using OAUTH_COMPLETE for consistency? Or a specific ADDED_COMPLETE?)
                  console.log(`ACCOUNT_ADDED processing finished: success=${success}, error=${errorMsg}`);
                  browser.runtime.sendMessage({
                    type: 'OAUTH_COMPLETE', // Re-use OAUTH_COMPLETE for simplicity?
                    success: success,
                    error: success ? undefined : errorMsg,
                    account: success ? account : undefined // Include account info on success
                  }).catch(err => {
                      console.log('[ACCOUNT_ADDED] Could not send completion message:', err.message);
                  });
              })();
              return true; // Indicate async
          } else {
              console.error('ACCOUNT_ADDED message received without valid account data.');
              sendResponse({ success: false, error: 'Invalid account data provided.' });
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

    // Initial load of accounts
    initializeAccounts().catch(error => {
        console.error('Failed to initialize accounts on startup:', error);
    });

    // Listener for storage changes to keep accounts in sync
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.accounts) {
        console.log('Account storage changed, re-initializing...');
        initializeAccounts().catch(error => {
          console.error('Failed to re-initialize accounts after storage change:', error);
        });
      }
    });
  }
});
