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
// Use the correct metadata URL as client_id
const CLIENT_ID = 'https://notisky.symm.app/client-metadata/client.json';
// Use the redirect URI that's registered in the client metadata
const SERVER_REDIRECT_URI = 'https://notisky.symm.app/api/auth/extension-callback';

// Target URL for programmatic injection
const AUTH_FINALIZE_URL_ORIGIN = 'https://notisky.symm.app';
const AUTH_FINALIZE_URL_PATH = '/api/auth/extension-callback';

// Store for authenticated accounts AND their agent instances
let activeAgents: Record<string, BskyAgent> = {};
// Store polling intervals
const pollingIntervals: Record<string, number> = {};

// Store for DPoP keys (in memory for this session)
const dpopKeys: Record<string, CryptoKeyPair> = {};
// Store for DPoP nonces per server
let dpopServerNonce: string | null = null;

// Get the correct global object for this context
const globalCrypto = typeof self !== 'undefined' ? self.crypto : 
                    typeof window !== 'undefined' ? window.crypto : 
                    typeof globalThis !== 'undefined' ? globalThis.crypto : 
                    crypto;

// Function to generate a DPoP key pair for a session
async function generateDpopKeyPair(): Promise<CryptoKeyPair> {
  return await globalCrypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256', // ES256 required by Bluesky
    },
    true, // extractable
    ['sign', 'verify']
  );
}

// Function to create a DPoP JWT for a request
async function createDpopProof(
  url: string, 
  method: string, 
  keyPair: CryptoKeyPair,
  nonce?: string
): Promise<string> {
  // Create header
  const publicKey = await exportJWK(keyPair.publicKey);
  const header = {
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: publicKey
  };

  // Create payload with unique jti
  const jti = globalCrypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  const payload: any = {
    jti: jti,
    htm: method,
    htu: url,
    iat: now,
    exp: now + 60, // Short expiry
  };

  // Add nonce if provided
  if (nonce) {
    payload.nonce = nonce;
  }

  // Create unsigned token
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  
  // Sign the token
  const encoder = new TextEncoder();
  const data = encoder.encode(signingInput);
  const signature = await globalCrypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: {name: 'SHA-256'},
    },
    keyPair.privateKey,
    data
  );

  // Convert signature to base64url
  const signatureBase64 = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  // Return the complete JWT
  return `${signingInput}.${signatureBase64}`;
}

// Helper function to export a key to JWK format
async function exportJWK(key: CryptoKey): Promise<any> {
  const jwk = await globalCrypto.subtle.exportKey('jwk', key);
  // Remove private key fields
  delete jwk.d;
  delete jwk.dp;
  delete jwk.dq;
  delete jwk.q;
  delete jwk.qi;
  return jwk;
}

// Helper function for base64url encoding
function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Function to perform OAuth Token Exchange (PKCE only, no DPoP for now)
async function exchangeCodeForTokenPkce(
  code: string, 
  verifier: string, 
  clientId: string, // Passed from login flow
  redirectUri: string // Passed from login flow
): Promise<any> { // Returns the raw fetch Response
  console.log('[Background][Exchange] Performing PKCE token exchange...');
  console.log(`[Background][Exchange] Using redirect_uri: ${redirectUri}`);
  console.log(`[Background][Exchange] Using client_id: ${clientId}`);
  
  const tokenRequestBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri, // Use the correct extension redirect URI
    client_id: clientId,       // Use the client ID from the login flow
    code_verifier: verifier
  });

  console.log('[Background][Exchange] Token request payload:', tokenRequestBody.toString());

  try {
    // Use Bluesky's standard token endpoint
    const response = await fetch(TOKEN_ENDPOINT, { // TOKEN_ENDPOINT should be https://bsky.social/oauth/token
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json' // Expect JSON response
      },
      body: tokenRequestBody
    });

    console.log('[Background][Exchange] Token response status:', response.status);
    // Optionally log headers if needed for debugging
    // console.log('[Background][Exchange] Token response headers:', Object.fromEntries(response.headers.entries()));

    return response; // Return the raw response for processing
  } catch (error) {
    console.error('[Background][Exchange] Token exchange fetch error:', error);
    throw error; // Re-throw to be caught by the caller
  }
}

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
            service: BLUESKY_SERVICE 
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
      // Call startNotificationPolling with the account
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

// Define a placeholder or actual uninstall URL if needed
const UNINSTALL_URL = 'https://example.com/uninstalled'; // Replace if needed

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

      // --- NEW: Handler for EXCHANGE_CODE from Login.tsx ---
      if (message.type === 'EXCHANGE_CODE') {
        const { code, state, clientId, redirectUri } = message.data || {};
        console.log(`[Background][EXCHANGE_CODE] Received code for state: ${state?.substring(0,5)}...`);

        if (!code || !state || !clientId || !redirectUri) {
          console.error('[Background][EXCHANGE_CODE] Missing required data in message.', message.data);
          // Send failure back to login page (and popup potentially)
          browser.runtime.sendMessage({ 
              type: 'OAUTH_COMPLETE', 
              success: false, 
              error: 'Internal Error: Missing data for token exchange.' 
          }).catch(()=>{});
          if (sendResponse) sendResponse({ success: false, error: 'Missing data'});
          return false; // Indicate synchronous response sending is not needed / handled
        }
        
        // Acknowledge receipt before async operations
        if (sendResponse) sendResponse({ success: true, message: 'Processing code exchange...' });

        // Use IIFE to handle async logic cleanly
        (async () => {
            let success = false;
            let errorMsg = 'Unknown error during token exchange process.';
            let accountData: Account | null = null;

            try {
                const verifier = await retrieveAndClearPkceState(state);
                if (!verifier) {
                    throw new Error(`PKCE Verifier not found or expired for state: ${state}. Please try logging in again.`);
                }
                console.log('[Background][EXCHANGE_CODE] Retrieved PKCE verifier.');

                // Perform the token exchange using the new function
                const tokenResponse = await exchangeCodeForTokenPkce(code, verifier, clientId, redirectUri);

                if (!tokenResponse.ok) {
                    // Handle error response from Bluesky
                    const errorText = await tokenResponse.text();
                    let errorData = { error: 'token_exchange_failed', error_description: errorText };
                    try { errorData = JSON.parse(errorText); } catch (e) { /* ignore if not JSON */ }
                    console.error(`[Background][EXCHANGE_CODE] Token exchange failed. Status: ${tokenResponse.status}, Response:`, errorData);
                    throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorData.error_description || errorData.error || 'Unknown error'}`);
                }

                // Process successful token response
                const tokenData = await tokenResponse.json();
                console.log('[Background][EXCHANGE_CODE] Received token data.'); // Avoid logging tokens themselves

                // Create/Update Account object (assuming tokenResponseToAccount handles the structure)
                // We might need the user's DID/Handle - requires another API call typically
                // For now, let's assume tokenData contains enough info or tokenResponseToAccount can derive it
                const tempAgent = new BskyAgent({ service: BLUESKY_SERVICE });
                await tempAgent.resumeSession({
                    accessJwt: tokenData.access_token, 
                    refreshJwt: tokenData.refresh_token, 
                    did: tokenData.did, // Assuming Bluesky returns did
                    handle: tokenData.handle // Assuming Bluesky returns handle (it might not!)
                 });
                 
                 if (!tempAgent.session?.did || !tempAgent.session?.handle) {
                     // Need to fetch profile if not included in token response
                     console.log('[Background][EXCHANGE_CODE] Fetching profile details using new token...');
                     const profileRes = await tempAgent.api.app.bsky.actor.getProfile({ actor: tokenData.did || 'me' }); 
                     if (!profileRes.data.did || !profileRes.data.handle) {
                        throw new Error('Failed to retrieve profile information (DID/Handle) after token exchange.');
                     }
                     tokenData.did = profileRes.data.did;
                     tokenData.handle = profileRes.data.handle;
                 }
                 
                accountData = await tokenResponseToAccount(tokenData); 
                if (!accountData) {
                    throw new Error('Failed to process token data into account structure.');
                }

                console.log(`[Background][EXCHANGE_CODE] Saving account: ${accountData.handle} (${accountData.did})`);
                await saveAccount(accountData);

                // Activate the new session
                const agent = await activateOAuthSession(accountData);
                if (!agent) {
                    throw new Error('Failed to activate agent session after successful token exchange.');
                }
                activeAgents[accountData.did] = agent;
                startPollingForAccount(accountData, agent);

                success = true;
                console.log(`[Background][EXCHANGE_CODE] Account ${accountData.handle} added and polling started.`);

            } catch (err: any) {
                console.error('[Background][EXCHANGE_CODE] Error during processing:', err);
                errorMsg = err.message || 'An unknown error occurred.';
                // Ensure accountData is null on error if it was partially populated
                accountData = null; 
            }

            // Send final result message
            console.log(`[Background][EXCHANGE_CODE] Sending OAUTH_COMPLETE. Success: ${success}`);
            browser.runtime.sendMessage({
                type: 'OAUTH_COMPLETE',
                success: success,
                account: success && accountData ? { did: accountData.did, handle: accountData.handle } : undefined,
                error: !success ? errorMsg : undefined
            }).catch((e) => console.warn('[Background][EXCHANGE_CODE] Failed to send OAUTH_COMPLETE message', e));

        })(); // End async IIFE

        return true; // Indicate async response pending
      }
      
      // --- OLD: OAUTH_CALLBACK handler (keep for now, maybe remove later) ---
      if (message.type === 'OAUTH_CALLBACK') {
        console.warn('[Background] OAUTH_CALLBACK handler invoked - this might be legacy.');
        const { code, state, error, error_description } = message.data || {};

        // Handle errors passed from injected script
        if (error) {
            console.error('[Injected Script] Error in URL:', error, error_description);
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

                console.log('[Background][OAUTH_CALLBACK] Performing token exchange... [LEGACY PATH]');
                // Use the new function, but with the old constants defined in this file
                // This whole block is likely unused now, but we fix the call site
                const tokenResponse = await exchangeCodeForTokenPkce(code, verifier, CLIENT_ID, SERVER_REDIRECT_URI);

                // Process the token response
                if (!tokenResponse.ok) {
                  // Handle error response
                  const errorText = await tokenResponse.text();
                  console.log('[Background][OAUTH_CALLBACK] Error response body:', errorText);
                  
                  let errorData: { error: string, error_description?: string } = { error: 'token_exchange_failed' };
                  
                  try {
                    errorData = JSON.parse(errorText);
                    console.log('[Background][OAUTH_CALLBACK] Parsed error data:', errorData);
                  } catch (e) {
                    // If not JSON, use text as error description
                    console.log('[Background][OAUTH_CALLBACK] Error response is not JSON, using as error description');
                    errorData.error_description = errorText;
                  }
                  
                  console.error(`[Background][OAUTH_CALLBACK] Token exchange failed. Status: ${tokenResponse.status}, Response:`, errorData);
                  throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorData.error_description || errorData.error || 'Unknown error'}`);
                }
                
                // Parse successful response
                const tokenData = await tokenResponse.json();
                console.log('[Background][OAUTH_CALLBACK] Received token data:', 
                  JSON.stringify({
                    ...tokenData,
                    access_token: tokenData.access_token ? '[REDACTED]' : undefined,
                    refresh_token: tokenData.refresh_token ? '[REDACTED]' : undefined
                  })
                );
                
                if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.did) {
                  console.error("[Background][OAUTH_CALLBACK] Token response missing required fields:", 
                    JSON.stringify({
                      has_access_token: !!tokenData.access_token,
                      has_refresh_token: !!tokenData.refresh_token,
                      has_did: !!tokenData.did,
                      keys: Object.keys(tokenData)
                    })
                  );
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

    // Cleanup on extension uninstall (use defined constant)
    browser.runtime.setUninstallURL(UNINSTALL_URL);
  },

  // --- Programmatic injection removed ---
});
