import BskyAgent from '@atproto/api';
import { Account, loadAccounts, saveAccount, removeAccount, tokenResponseToAccount } from '../src/services/auth';
import { 
  startNotificationPolling, 
  stopNotificationPolling, 
  updateNotificationBadge,
  resetNotificationCount,
  stopAllPolling
} from '../src/services/notifications';

// Constants for OAuth Token Exchange (Server Flow)
const BLUESKY_SERVICE = 'https://bsky.social'; 
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;
// Use the metadata URL as client_id and the server callback as redirect_uri
const CLIENT_METADATA_URL = 'https://notisky.symm.app/client-metadata/client.json'; 
const SERVER_REDIRECT_URI = 'https://notisky.symm.app/api/auth/extension-callback'; 

// Target URL for programmatic injection
const AUTH_FINALIZE_URL_ORIGIN = 'https://notisky.symm.app';
const AUTH_FINALIZE_URL_PATH = '/auth-finalize.html';

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
        // Create agent first
        const agent = new BskyAgent({ 
            service: BLUESKY_SERVICE, 
            // Remove session from initial options
         });
        
        // Then resume the session
        await agent.resumeSession({
            did: account.did,
            handle: account.handle,
            email: account.email,
            accessJwt: account.accessJwt,
            refreshJwt: account.refreshJwt
        });

        // Verify session resumed correctly
        if (agent.session?.did !== account.did) {
            console.error(`Failed to resume agent session correctly for ${account.did}`);
            // Optionally try to refresh token here if resume fails?
            return null;
        }
        console.log(`Agent session resumed for ${account.did}`);
        return agent;
    } catch (error) {
        console.error(`Error creating/resuming agent for ${account.did}:`, error);
        return null;
    }
}

// Start notification polling using an active agent
function startPollingForAccount(account: Account, agent: BskyAgent): void {
  if (!agent || !agent.session) {
      console.error(`Attempted to start polling for ${account.did} without a valid agent session.`);
      return;
  }
  // Stop any previous polling for this account
  stopNotificationPolling(account.did, pollingIntervals); 
  
  console.log(`Starting notification polling for ${account.handle} (${account.did})`);
  try {
      // Call startNotificationPolling with just the account
      const intervalId = startNotificationPolling(account);
      // Store the returned interval ID
      pollingIntervals[account.did] = intervalId;
      console.log(`Polling started for ${account.did} with interval ID: ${intervalId}`);
  } catch (error) {
      console.error(`Failed to start polling for ${account.did}:`, error);
  }
}

// Stop notification polling for an account
function stopPollingForAccount(did: string): void {
  if (pollingIntervals[did]) {
    // stopNotificationPolling expects the map as the second argument
    stopNotificationPolling(did, pollingIntervals);
    // It should handle deleting the entry from the map internally
    // delete pollingIntervals[did]; // Remove this line
    console.log(`Stopped polling for ${did}`);
  } else {
      // Keep this warning
    // console.warn(`No active polling interval found for ${did} to stop.`);
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

// Function containing the logic to be injected into the auth finalize page
function injectedAuthFinalizeLogic() {
  // This code runs in the context of the web page
  console.log('[Injected Script] Running in finalize page.');
  
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
         // Send error details back to background?
        try {
            const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
            await runtime.sendMessage({ type: 'OAUTH_CALLBACK', data: { error, error_description: errorDescription, state } });
        } catch(e){ console.warn('[Injected Script] Failed to send error to background', e); }
        return;
      }

      if (!code || !state) {
        throw new Error('Missing code or state parameter in callback URL.');
      }

      setStatus('Sending details to background service...');
      console.log('[Injected Script] Sending OAUTH_CALLBACK to background...');

      const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
      const response = await runtime.sendMessage({
        type: 'OAUTH_CALLBACK',
        data: { code, state } // Send code and original state
      });

      console.log('[Injected Script] Background response:', response);
      if (response && response.success) {
          setStatus('Authentication details sent. Background is processing...');
      } else {
          setStatus(`Error during background processing: ${response?.error || 'Unknown error'}`, true);
      }
      
      // Maybe don't close automatically, let background message control it?
      // setTimeout(() => { ... }, 3000);

    } catch (err: any) {
      console.error('[Injected Script] Error:', err);
      setStatus('Error: ' + (err.message || String(err)), true);
      // Send error details back to background?
      try {
          const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
          await runtime.sendMessage({ type: 'OAUTH_CALLBACK', data: { error: 'script_error', error_description: err.message, state: new URLSearchParams(window.location.search).get('state') } });
      } catch(e){ console.warn('[Injected Script] Failed to send script error to background', e); }
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

    // Notification permission check (keep as is)
    browser.notifications.getPermissionLevel(level => {
      console.log('Notification permission level:', level);
    });

    // Setup message handlers
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('Background received message:', message.type, 'from', sender.tab?.id || sender.url || sender.id);

      // --- REMOVE EXCHANGE_OAUTH_CODE handler --- 
      // if (message.type === 'EXCHANGE_OAUTH_CODE') { ... }
      
      // --- REINSTATE OAUTH_CALLBACK handler ---
      if (message.type === 'OAUTH_CALLBACK') {
        console.log('[Background] Received OAUTH_CALLBACK from injected script');
        const { code, state, error, error_description } = message.data || {};

        // Handle errors passed from injected script
        if (error) {
            console.error(`[Background][OAUTH_CALLBACK] Error received from callback: ${error} - ${error_description}`);
            // Send failure message to login page
            browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: `OAuth Error: ${error_description || error}` }).catch(()=>{});
            if (sendResponse) sendResponse({ success: false, error: 'OAuth error received' }); // Acknowledge receipt of error
            // Potentially try to clean up PKCE state if state is present
            if (state) { 
                retrieveAndClearPkceState(state).catch(e => console.warn('Failed cleanup on error', e)); 
            }
            return false;
        }

        if (!code || !state) {
          console.error('[Background][OAUTH_CALLBACK] Missing code or state in message data.');
          if (sendResponse) sendResponse({ success: false, error: 'Missing code or state' });
          // Send failure message to login page
          browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: 'Callback missing code or state' }).catch(()=>{});
          return false; 
        }
        
        // Acknowledge receipt before async processing (as injected script waits)
        if (sendResponse) sendResponse({ success: true, message: 'Processing callback...'});

        // Prevent duplicate processing (optional but good practice)
        const processedFlagKey = `processed_${state}`;
        (async () => {
            const processedCheck = await browser.storage.session.get(processedFlagKey);
            if (processedCheck[processedFlagKey]) {
                console.warn(`[Background][OAUTH_CALLBACK] State already processed: ${state.substring(0,5)}...`);
                // Don't send another OAUTH_COMPLETE here, already handled.
                return; 
            }
            await browser.storage.session.set({ [processedFlagKey]: true });
            console.log(`[Background][OAUTH_CALLBACK] Marked state as processed: ${state.substring(0,5)}...`);

            // --- Process Token Exchange --- 
            let success = false;
            let errorMsg = 'Unknown error during token exchange.';
            let accountData: Account | null = null;
            let verifier: string | null = null;

            try {
                console.log(`[Background][OAUTH_CALLBACK] Processing code for state: ${state.substring(0,5)}...`);
                verifier = await retrieveAndClearPkceState(state);
                if (!verifier) {
                    throw new Error(`PKCE Verifier not found or expired for state: ${state}. Please try logging in again.`);
                }
                console.log('[Background][OAUTH_CALLBACK] Retrieved PKCE verifier.');

                console.log('[Background][OAUTH_CALLBACK] Performing token exchange...');
                console.log(`[Background][OAUTH_CALLBACK] Using redirect_uri: ${SERVER_REDIRECT_URI}`);
                console.log(`[Background][OAUTH_CALLBACK] Using client_id: ${CLIENT_METADATA_URL}`);
                
                const tokenRequestBody = new URLSearchParams({
                  grant_type: 'authorization_code',
                  code: code,
                  redirect_uri: SERVER_REDIRECT_URI, // Use SERVER URI
                  client_id: CLIENT_METADATA_URL, // Use METADATA URL
                  code_verifier: verifier
                });

                const tokenResponse = await fetch(TOKEN_ENDPOINT, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                  },
                  body: tokenRequestBody.toString()
                });

                const responseBodyText = await tokenResponse.text();
                let tokenData: any = {};

                if (!tokenResponse.ok) {
                  let errorJson: any = { error: 'token_exchange_failed', error_description: 'Failed to exchange code for token.' };
                  try {
                    errorJson = JSON.parse(responseBodyText);
                  } catch (parseError) { 
                    console.warn("[Background][OAUTH_CALLBACK] Token error response was not valid JSON:", responseBodyText);
                    errorJson.error_description = responseBodyText;
                  }
                  console.error(`[Background][OAUTH_CALLBACK] Token exchange failed. Status: ${tokenResponse.status}, Response:`, errorJson);
                  throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorJson.error_description || errorJson.error || 'Unknown error'}`);
                }

                try {
                  tokenData = JSON.parse(responseBodyText);
                } catch (parseError) {
                  console.error("[Background][OAUTH_CALLBACK] Failed to parse successful token response JSON:", responseBodyText, parseError);
                  throw new Error('Failed to parse successful token response.');
                }

                if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.did) {
                  console.error("[Background][OAUTH_CALLBACK] Token response missing required fields:", tokenData);
                  throw new Error('Token response missing required fields (access_token, refresh_token, did).');
                }

                console.log(`[Background][OAUTH_CALLBACK] Token exchange successful for DID: ${tokenData.did}`);
                const newAccount = await tokenResponseToAccount(tokenData);
                if (!newAccount) {
                  throw new Error('Failed to create account object from token response.');
                }
                accountData = newAccount;

                await saveAccount(newAccount);
                const agent = await activateOAuthSession(newAccount);
                if (agent) {
                  activeAgents[newAccount.did] = agent;
                  startPollingForAccount(newAccount, agent); // Uses fixed version
                  success = true;
                  console.log(`[Background][OAUTH_CALLBACK] Account ${newAccount.handle} activated.`);
                } else {
                  await removeAccount(newAccount.did);
                  throw new Error('Failed to activate agent session after token exchange. Account removed.');
                }

            } catch (err: any) {
                console.error('[Background][OAUTH_CALLBACK] Error during token exchange or account setup:', err);
                errorMsg = err.message || 'An unknown error occurred.';
                // PKCE state already cleared if verifier was retrieved
            }

            // --- Send final status message to Login Page --- 
            console.log(`[Background][OAUTH_CALLBACK] Sending OAUTH_COMPLETE to UI. Success: ${success}`);
            try {
                // Find the login tab 
                const loginTabs = await browser.tabs.query({ url: browser.runtime.getURL("/login.html") });
                if (loginTabs.length > 0 && loginTabs[0].id) {
                    await browser.tabs.sendMessage(loginTabs[0].id, { 
                        type: 'OAUTH_COMPLETE', 
                        success: success, 
                        error: success ? undefined : errorMsg, 
                        account: success ? accountData : undefined
                    });
                } else {
                    console.warn('[Background][OAUTH_CALLBACK] Could not find Login tab to send OAUTH_COMPLETE message.');
                    if (success) updateNotificationBadge(); // Update badge as fallback on success
                }
            } catch (sendMessageError: any) {
                console.error('[Background][OAUTH_CALLBACK] Failed to send OAUTH_COMPLETE message to Login UI:', sendMessageError);
            }
        })(); // End async IIFE for processing

        return true; // Indicate async handling initiated
      }
      
      // Other message handlers (GET_ACCOUNTS, REMOVE_ACCOUNT, etc. - keep as is)
      if (message.type === 'GET_ACCOUNTS') {
          // ... existing logic ...
          return false;
      }
      
      if (message.type === 'NOTIFICATION_VIEW') {
          // ... existing logic ...
          return false;
      }
      
      if (message.type === 'REMOVE_ACCOUNT') {
          // ... existing logic ...
          return true; // Indicate async response
      }
      
      if (message.type === 'GET_AUTH_STATUS') {
          // ... existing logic ...
          return false;
      }
      
      console.warn('Unhandled message type in background:', message.type);
      return false; 
    });

    // --- REINSTATE tabs.onUpdated listener for injection ---
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' && tab.url) {
            try {
                const url = new URL(tab.url);
                // Check if it's the finalize URL hosted by the auth server
                if (url.origin === AUTH_FINALIZE_URL_ORIGIN && url.pathname === AUTH_FINALIZE_URL_PATH) {
                    console.log(`[Background] Detected auth finalize page loaded: ${tab.url}`);
                    
                    // Check scripting permission for the *server's* origin
                    const hasPermission = await browser.permissions.contains({ origins: [url.origin + '/*'] });
                    if (!hasPermission) {
                       console.error(`[Background] Missing host permission for ${url.origin} needed for script injection.`);
                       // TODO: Maybe notify user or request permission?
                       return; 
                    }

                    console.log(`[Background] Injecting script into ${tab.url}`);
                    await browser.scripting.executeScript({
                        target: { tabId: tabId },
                        func: injectedAuthFinalizeLogic, 
                    });
                    console.log('[Background] Injected auth finalize script.');
                }
            } catch (error: any) {
                if (!(error instanceof TypeError && error.message.includes('Invalid URL'))) {
                   console.error('[Background] Error in tabs.onUpdated listener:', error);
                }
            }
        }
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
