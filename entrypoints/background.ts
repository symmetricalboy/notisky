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
const BLUESKY_SERVICE = 'https://bsky.social'; 
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;
// Client ID is the hosted metadata URL (remains the same)
const CLIENT_METADATA_URL = 'https://notisky.symm.app/client-metadata/client.json'; 

// Redirect URI is now specific to the extension
// Get it dynamically at runtime
let EXTENSION_REDIRECT_URI: string | undefined;
try {
  EXTENSION_REDIRECT_URI = browser.identity.getRedirectURL();
  console.log('[Background] Determined Extension Redirect URI:', EXTENSION_REDIRECT_URI);
  if (!EXTENSION_REDIRECT_URI) {
    console.error('[Background] CRITICAL: Could not determine extension redirect URI on load.');
  }
} catch (e) {
    console.error('[Background] CRITICAL: Error getting extension redirect URI:', e);
}

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

// Retrieve and remove PKCE state from session storage
async function retrieveAndClearPkceState(state: string): Promise<string | null> {
  const key = `pkce_${state}`;
  try {
    const result = await browser.storage.session.get(key);
    const verifier = result[key];
    if (verifier && typeof verifier === 'string') {
      console.log(`[PKCE] Retrieved verifier from session storage for state: ${state.substring(0,5)}...`);
      await browser.storage.session.remove(key); // Clear after retrieval
      console.log(`[PKCE] Cleared session storage for key: ${key}`);
      return verifier;
    } else {
      console.error(`[PKCE] Verifier not found or invalid for state: ${state}`);
      return null;
    }
  } catch (error) {
     console.error(`[PKCE] Error accessing PKCE session storage for key ${key}:`, error);
     return null;
  }
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

    if (!EXTENSION_REDIRECT_URI) {
        console.error('!!! Background service started WITHOUT a valid redirect URI. OAuth flow will fail. !!!');
        // Potentially disable OAuth functionality or notify user?
    }

    // Notification permission check (keep as is)
    browser.notifications.getPermissionLevel(level => {
      console.log('Notification permission level:', level);
    });

    // Setup message handlers
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('Background received message:', message.type, 'from', sender.tab?.id || sender.id);

      // --- REINSTATE EXCHANGE_OAUTH_CODE handler ---
      if (message.type === 'EXCHANGE_OAUTH_CODE') {
        console.log('[Background] Received EXCHANGE_OAUTH_CODE from Login page');
        const { code, state } = message.data || {}; // Expecting code and state

        if (!code || !state) {
          console.error('[Background][EXCHANGE_OAUTH_CODE] Missing code or state in message data');
          sendResponse({ success: false, error: 'Missing code or state' });
          return false;
        }
        
        if (!EXTENSION_REDIRECT_URI) {
            console.error('[Background][EXCHANGE_OAUTH_CODE] Cannot process - missing extension redirect URI.');
            sendResponse({ success: false, error: 'Background service missing redirect URI configuration.'});
            return false;
        }

        // Process token exchange asynchronously
        (async () => {
          let success = false;
          let errorMsg = 'Unknown error during token exchange.';
          let accountData: Account | null = null;
          let verifier: string | null = null;

          try {
            // Retrieve the verifier using the state
            verifier = await retrieveAndClearPkceState(state);
            if (!verifier) {
                // State might be old/invalid, or cleanup happened prematurely
                throw new Error(`PKCE Verifier not found or expired for state: ${state}. Please try logging in again.`);
            }
            console.log(`[Background][EXCHANGE_OAUTH_CODE] Retrieved PKCE verifier for state: ${state.substring(0,5)}...`);

            // Perform token exchange using the EXTENSION redirect URI
            console.log('[Background][EXCHANGE_OAUTH_CODE] Performing token exchange...');
            console.log(`[Background][EXCHANGE_OAUTH_CODE] Using redirect_uri: ${EXTENSION_REDIRECT_URI}`);
            console.log(`[Background][EXCHANGE_OAUTH_CODE] Using client_id: ${CLIENT_METADATA_URL}`);
            
            const tokenRequestBody = new URLSearchParams({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: EXTENSION_REDIRECT_URI, // Use extension URI
              client_id: CLIENT_METADATA_URL,
              code_verifier: verifier // Retrieved using state
            });

            const tokenResponse = await fetch(TOKEN_ENDPOINT, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: tokenRequestBody.toString()
            });

            const responseBodyText = await tokenResponse.text();
            let tokenData: any = {}; // Use 'any' temporarily for parsing

            if (!tokenResponse.ok) {
              let errorJson: any = { error: 'unknown_exchange_error', error_description: 'Failed to exchange token.' };
              try {
                errorJson = JSON.parse(responseBodyText);
              } catch (parseError) {
                console.warn("[Background][EXCHANGE_OAUTH_CODE] Token error response was not valid JSON:", responseBodyText);
                errorJson.error_description = responseBodyText; // Use raw text if not JSON
              }
              console.error(`[Background][EXCHANGE_OAUTH_CODE] Token exchange failed. Status: ${tokenResponse.status}, Response:`, errorJson);
              throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorJson.error_description || errorJson.error || 'Unknown error'}`);
            }

            // Handle success: Parse the text body as JSON
            try {
              tokenData = JSON.parse(responseBodyText);
            } catch (parseError) {
              console.error("[Background][EXCHANGE_OAUTH_CODE] Failed to parse successful token response JSON:", responseBodyText, parseError);
              throw new Error('Failed to parse successful token response.');
            }

            // Validate the parsed tokenData object
            if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.did) {
              console.error("[Background][EXCHANGE_OAUTH_CODE] Token response missing required fields:", tokenData);
              throw new Error('Token response missing required fields (access_token, refresh_token, did).');
            }

            console.log(`[Background][EXCHANGE_OAUTH_CODE] Token exchange successful for DID: ${tokenData.did}`);

            // Convert token data to Account structure
            const newAccount = await tokenResponseToAccount(tokenData);
            if (!newAccount) {
              throw new Error('Failed to create account object from token response.');
            }
            accountData = newAccount; // Store for final message

            // Save account and activate session/polling
            await saveAccount(newAccount);
            const agent = await activateOAuthSession(newAccount);
            if (agent) {
              activeAgents[newAccount.did] = agent;
              startPollingForAccount(newAccount, agent);
              success = true;
              console.log(`[Background][EXCHANGE_OAUTH_CODE] Account ${newAccount.handle} activated and polling started.`);
            } else {
              // Account saved, but activation failed. Remove?
              await removeAccount(newAccount.did); 
              throw new Error('Failed to activate agent session after token exchange. Account removed.');
            }
          } catch (err: any) {
            console.error('[Background][EXCHANGE_OAUTH_CODE] Error during exchange or account setup:', err);
            errorMsg = err.message || 'An unknown error occurred.';
            // Attempt to clean up PKCE state if verifier was retrieved but exchange failed
            // Note: retrieveAndClearPkceState already clears it on successful retrieval.
          }

          // Send final completion message back to the Login page
          console.log(`[Background][EXCHANGE_OAUTH_CODE] Sending OAUTH_COMPLETE to UI. Success: ${success}`);
          try {
            // Find the login tab (sender might be closed)
            const loginTabs = await browser.tabs.query({ url: browser.runtime.getURL("/login.html") });
            if (loginTabs.length > 0 && loginTabs[0].id) {
                await browser.tabs.sendMessage(loginTabs[0].id, {
                    type: 'OAUTH_COMPLETE',
                    success: success,
                    error: success ? undefined : errorMsg,
                    account: success ? accountData : undefined
                });
            } else {
                 console.warn('[Background][EXCHANGE_OAUTH_CODE] Could not find Login tab to send OAUTH_COMPLETE message.');
                 // Maybe update badge or show notification as fallback?
                 if (success) updateNotificationBadge(); 
            }
          } catch (sendMessageError: any) {
             console.error('[Background][EXCHANGE_OAUTH_CODE] Failed to send OAUTH_COMPLETE message to Login UI:', sendMessageError);
          }
        })().catch(err => {
          // Should not happen if try/catch inside async is robust
          console.error('[Background][EXCHANGE_OAUTH_CODE] Unexpected top-level error:', err);
          // Attempt to send failure message if possible
          browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: 'Unexpected background error.' }).catch(()=>{});
        });

        return true; // Indicate async response
      }
      
      // --- REMOVE OAUTH_CALLBACK handler ---
      // if (message.type === 'OAUTH_CALLBACK') { ... }

      // Other message handlers (GET_ACCOUNTS, REMOVE_ACCOUNT, etc. - keep as is)
      // ... existing code ...
      
      console.warn('Unhandled message type in background:', message.type);
      return false; 
    });

    // Notification click handler (keep as is)
    browser.notifications.onClicked.addListener((notificationId) => {
      console.log(`Notification clicked: ${notificationId}`);
      browser.tabs.create({ url: 'https://bsky.app/notifications' });
      browser.notifications.clear(notificationId);
    });

    // Initial load of accounts (keep as is)
    initializeAccounts().catch(error => {
        console.error('Failed to initialize accounts on startup:', error);
    });

    // Storage change listener (keep as is)
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
