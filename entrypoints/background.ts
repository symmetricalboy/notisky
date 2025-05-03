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
const CLIENT_METADATA_URL = 'https://notisky.symm.app/client-metadata/client.json'; // Corrected Client ID URL
const REDIRECT_URI = 'https://notisky.symm.app/api/auth/extension-callback'; // Corrected Redirect URI

// Target URL for programmatic injection
const AUTH_FINALIZE_URL_ORIGIN = 'https://notisky.symm.app';
const AUTH_FINALIZE_URL_PATH = '/auth-finalize.html';

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

// Function containing the logic to be injected into the auth finalize page
function injectedAuthFinalizeLogic() {
  // This code runs in the context of the web page
  console.log('[Injected Script] Running in finalize page.');
  
  /** 
   * Updates the status message on the page.
   */
  function setStatus(message: string, isError = false) {
    const statusEl = document.getElementById('auth-status');
    const messageEl = document.getElementById('auth-message');
    if (statusEl && messageEl) {
      statusEl.textContent = message;
      statusEl.className = isError ? 'status error' : 'status success';
      messageEl.textContent = isError ? 'Please check the extension logs or try again.' : 'You can now close this window.';
    } else {
      console.warn('[Injected Script] Status elements not found');
    }
  }

  (async () => {
    try {
      setStatus('Reading parameters...');
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error');
      const errorDescription = params.get('error_description');

      if (error) {
        console.error('[Injected Script] Error in URL:', error, errorDescription);
        setStatus(`Error: ${error} - ${errorDescription || 'Please try again.'}`, true);
        return;
      }

      if (!code || !state) {
        throw new Error('Missing code or state parameter in callback URL.');
      }

      setStatus('Sending details to background service...');
      console.log('[Injected Script] Sending OAUTH_CALLBACK to background...');

      // Send message to background script (browser API is available here)
      // Note: `browser` might be undefined if running in pure Chrome, use `chrome` as fallback
      const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
      const response = await runtime.sendMessage({
        type: 'OAUTH_CALLBACK',
        data: { code, state }
      });

      console.log('[Injected Script] Background response:', response);
      setStatus('Authentication details sent. Background is processing...');

      setTimeout(() => {
         console.log('[Injected Script] Attempting to close window.');
         window.close();
         setStatus('Processing complete. Please close this window manually.', false);
      }, 3000);

    } catch (err) {
      console.error('[Injected Script] Error:', err);
      setStatus('Error: ' + (err instanceof Error ? err.message : String(err)), true);
    }
  })();
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

      if (message.type === 'OAUTH_CALLBACK') {
        console.log('[Background] Received OAUTH_CALLBACK from injected script or other source.');
        const { code, state } = message.data || {};

        if (!code || !state) {
          console.error('[Background][OAUTH_CALLBACK] Missing code or state in message data.');
          // Acknowledge if possible, though sender might be gone
          if (sendResponse) sendResponse({ success: false, error: 'Missing code or state' });
          return false; 
        }

        // Acknowledge receipt to the sender (the injected script)
        if (sendResponse) sendResponse({ success: true, message: 'Processing callback...'});

        // Process the token exchange asynchronously
        (async () => {
            let success = false;
            let errorMsg = 'Unknown error during token exchange.';
            let verifier: string | null = null;
            try {
                console.log(`[Background][OAUTH_CALLBACK] Processing code for state: ${state.substring(0,5)}...`);
                verifier = await retrieveAndClearPkceState(state);

                if (!verifier) {
                    throw new Error(`PKCE Verifier not found or expired for state: ${state}`);
                }
                console.log('[Background][OAUTH_CALLBACK] Retrieved PKCE verifier.');

                // --- Perform Token Exchange --- 
                console.log('[Background][OAUTH_CALLBACK] Performing token exchange...');
                const tokenRequestBody = new URLSearchParams({
                  grant_type: 'authorization_code',
                  code: code,
                  redirect_uri: REDIRECT_URI,
                  client_id: CLIENT_METADATA_URL,
                  code_verifier: verifier
                });

                const tokenResponse = await fetch(TOKEN_ENDPOINT, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                  },
                  body: tokenRequestBody.toString()
                });

                const tokenData = await tokenResponse.json();

                if (!tokenResponse.ok) {
                   throw new Error(`Token exchange failed (${tokenResponse.status}): ${tokenData.error || 'Unknown error'} - ${tokenData.error_description || 'No description'}`);
                }

                if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.did) {
                  throw new Error('Token response missing required fields (access_token, refresh_token, did).');
                }

                console.log(`[Background][OAUTH_CALLBACK] Token exchange successful for DID: ${tokenData.did}`);

                // Convert token data to Account structure (fetches profile for handle)
                const newAccount = await tokenResponseToAccount(tokenData);

                if (!newAccount) {
                  throw new Error('Failed to create account object from token response.');
                }

                // Save account and activate session/polling
                await saveAccount(newAccount);
                const agent = await activateOAuthSession(newAccount);
                if (agent) {
                  activeAgents[newAccount.did] = agent;
                  startPollingForAccount(newAccount, agent);
                  success = true;
                  console.log(`[Background][OAUTH_CALLBACK] Account ${newAccount.handle} activated and polling started.`);
                } else {
                  throw new Error('Failed to activate agent session after token exchange.');
                }

            } catch (err: any) {
                console.error('[Background][OAUTH_CALLBACK] Error during token exchange or account setup:', err);
                errorMsg = err.message || 'An unknown error occurred.';
                success = false;
                // Ensure PKCE state is cleared even on error if verifier was retrieved
                if (verifier && state) await retrieveAndClearPkceState(state); // Attempt cleanup just in case
            }

            // --- Send final status message to Popup --- 
            console.log(`[Background][OAUTH_CALLBACK] Sending OAUTH_COMPLETE to UI. Success: ${success}`);
            try {
              // Send globally, popup listener will pick it up
              await browser.runtime.sendMessage({ 
                type: 'OAUTH_COMPLETE', 
                success: success, 
                error: success ? undefined : errorMsg 
              });
            } catch (sendMessageError) {
              console.error('[Background][OAUTH_CALLBACK] Failed to send OAUTH_COMPLETE message to UI:', sendMessageError);
              // This might happen if the popup was closed. Should be okay.
            }
        })();

        return true; // Indicate async response started
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

    // --- New Tab Update Listener for Script Injection --- 
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        // Inject script only when the target page finishes loading
        if (changeInfo.status === 'complete' && tab.url) {
            try {
                const url = new URL(tab.url);
                if (url.origin === AUTH_FINALIZE_URL_ORIGIN && url.pathname === AUTH_FINALIZE_URL_PATH) {
                    console.log(`[Background] Detected auth finalize page loaded: ${tab.url}`);
                    
                    // Check if scripting permission is granted
                    const hasPermission = await browser.permissions.contains({ permissions: ['scripting'], origins: [url.origin + '/*'] });
                    if (!hasPermission) {
                       console.error(`[Background] Missing scripting permission for ${url.origin}`);
                       // Attempt to request permission? Or just log error.
                       // Maybe prompt user via notification?
                       return; 
                    }

                    await browser.scripting.executeScript({
                        target: { tabId: tabId },
                        func: injectedAuthFinalizeLogic, // Inject the function defined above
                        // files: ['entrypoints/auth-finalize-cs.js'] // Alternative: Inject the built file
                    });
                    console.log('[Background] Injected auth finalize script.');
                }
            } catch (error) {
                // Ignore errors from invalid URLs (like about:blank)
                if (!(error instanceof TypeError && error.message.includes('Invalid URL'))) {
                   console.error('[Background] Error in tabs.onUpdated listener:', error);
                }
            }
        }
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
