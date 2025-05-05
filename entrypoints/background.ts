import BskyAgent from '@atproto/api';
import * as jose from 'jose'; // Import jose for DPoP
import { Account, loadAccounts, saveAccount, removeAccount } from '../src/services/auth';
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
let dpopServerNonces: Record<string, string | null> = {}; // Store nonce per origin

// Flag to prevent concurrent initializations
let isInitializing = false;

// Get the correct global object for this context
const globalCrypto = typeof self !== 'undefined' ? self.crypto : 
                    typeof window !== 'undefined' ? window.crypto : 
                    typeof globalThis !== 'undefined' ? globalThis.crypto : 
                    crypto;

// Create a DPoP JWT proof using jose
async function createDpopProof(
  url: string, 
  method: string, 
  privateKey: jose.KeyLike | Uint8Array, 
  publicJwk: jose.JWK,
  accessToken: string, // Added accessToken parameter
  nonce?: string
): Promise<string> {
  
  // Header uses the provided public JWK
  const header: jose.JWTHeaderParameters = { // Use jose type
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: publicJwk // Pass the full JWK
  };

  // --- Calculate Access Token Hash (ath) --- 
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(accessToken);
  const tokenHashBuffer = await globalCrypto.subtle.digest('SHA-256', tokenData);
  // Convert hash buffer to base64url string
  const tokenHashBase64Url = btoa(String.fromCharCode(...new Uint8Array(tokenHashBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  // ------------------------------------------

  // Create the payload
  const payload: any = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ath: tokenHashBase64Url // Include the access token hash
  };
  
  if (nonce) {
    payload.nonce = nonce;
  }
  
  // Create and sign the DPoP token using only the private key
  const dpopToken = await new jose.SignJWT(payload)
    .setProtectedHeader(header)
    .sign(privateKey);
  
  return dpopToken;
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
async function activateOAuthSession(account: Account): Promise<BskyAgent | null> {
    // FOR NOW: Do not attempt to resume OAuth sessions on startup due to token/DPoP complexities.
    console.log(`Skipping activation for OAuth account ${account.handle} (${account.did}) on startup.`);
    return null; 
}

// Start notification polling using an active agent
function startPollingForAccount(
  account: Account, 
  agent: BskyAgent // Changed back to accept BskyAgent
): void {
  // Add back agent session check
  if (!agent || !agent.session) {
      console.error(`Attempted to start polling for ${account.did} without a valid agent session.`);
      return;
  }
  // Stop any previous polling for this account
  stopNotificationPolling(account.did, pollingIntervals); 
  
  console.log(`Starting notification polling for ${account.handle} (${account.did}) using agent session`);
  try {
      // Call startNotificationPolling with the account AND the existing agent
      // This assumes notifications.ts is updated to accept the agent again
      const intervalId = startNotificationPolling(account, agent); 
      if (intervalId === -1) {
          console.error(`Polling failed to start for ${account.did} (received interval ID -1)`);
          return; // Don't store invalid interval ID
      }
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
  // Prevent concurrent runs
  if (isInitializing) {
    console.log('Initialization already in progress, skipping redundant call.');
    return;
  }
  isInitializing = true;
  console.log('Initializing accounts...');
  
  let activeAgentCount = 0;
  try {
    // Load all accounts from storage
    const accountsRecord = await loadAccounts(); // Returns Record<string, Account>
    console.log('Accounts loaded from storage (record):', accountsRecord);
    const accounts = Object.values(accountsRecord); // Get array of accounts
    
    // Stop any existing polling before re-initializing
    stopAllPolling(pollingIntervals); // Pass the map here
    // Clear active agents (we will rebuild based on successful session activation)
    activeAgents = {}; 

    console.log(`Found ${accounts.length} accounts to initialize.`);

    for (const account of accounts) {
      // Basic validation - ensure core fields are present
      // Need DPoP keys as well if we are using agentFetchWithDpop
      if (!account || !account.did || !account.handle || 
          !account.accessJwt || !account.refreshJwt || !account.pdsUrl ||
          !account.dpopPrivateKeyJwk || !account.dpopPublicKeyJwk)
      { // Added DPoP key check
          console.warn(`Skipping initialization for account with missing data (incl. DPoP keys): ${account?.did || 'unknown'}`, account);
          continue; 
      }

      console.log(`Initializing agent for ${account.handle} (${account.did}) using stored OAuth tokens and DPoP fetch`);
      try {
        // --- BEGIN MODIFICATION (Revert to simpler init) ---
        // 1. Create agent WITHOUT custom fetch
        const agent = new BskyAgent({
          service: account.pdsUrl
        });

        // 2. Manually populate the session object 
        // This is necessary for checks like startPollingForAccount
        const sessionData = {
            did: account.did,
            handle: account.handle,
            accessJwt: account.accessJwt,
            refreshJwt: account.refreshJwt,
        };
        agent.session = sessionData; 
        console.log(`[Initialize] Manually set agent.session for ${account.handle}.`);

        // 3. SKIP agent.resumeSession() entirely
        console.log(`[Initialize] Skipping agent.resumeSession for ${account.handle}.`);

        // 4. Add agent and start polling 
        activeAgents[account.did] = agent;
        console.log(`Agent created for ${account.handle} (NO custom fetch assigned yet).`);
        startPollingForAccount(account, agent); 
        activeAgentCount++;
        // --- END MODIFICATION ---

      } catch (error) {
        console.error(`Failed to initialize agent for ${account.handle} (${account.did}):`, error);
        // Optionally remove account from storage if init fails critically?
        // await deactivateAccount(account.did); 
      }
    } // End for loop

  } catch (error) {
      console.error('Error initializing accounts:', error);
  } finally {
      console.log(`Initialization complete. Active agents (initialized): ${activeAgentCount}`);
      updateNotificationBadge(); // Update badge based on counts
      isInitializing = false; // Release the lock
  }
}

// Define a placeholder or actual uninstall URL if needed
const UNINSTALL_URL = 'https://example.com/uninstalled'; // Replace if needed

// Function to get nonce for a specific origin
function getServerNonce(origin: string): string | null {
    return dpopServerNonces[origin] || null;
}

// Function to set nonce for a specific origin
function setServerNonce(origin: string, nonce: string | null): void {
    if (nonce) {
        dpopServerNonces[origin] = nonce;
    } else {
        delete dpopServerNonces[origin];
    }
}

// --- DPoP Authenticated Fetch Helper (Modified for Agent) ---
// Now takes standard fetch arguments and expects 'this' to be the Account
export async function agentFetchWithDpop(
    this: Account, // Bind Account context here
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    const account = this;
    let urlStr: string;
    let options: RequestInit = { ...(init || {}) };

    // Handle Request object input
    if (input instanceof Request) {
        urlStr = input.url;
        // IMPORTANT: Create new options object, don't modify original Request object directly
        options = {
            method: input.method,
            headers: new Headers(input.headers),
            body: input.body ? await input.clone().arrayBuffer() : undefined, // Clone body if present
            mode: input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrer: input.referrer,
            integrity: input.integrity,
            // Merge options from init AFTER Request properties
            ...init,
        };
        // Merge headers separately
        if (init?.headers) {
             const initHeaders = new Headers(init.headers);
             initHeaders.forEach((value, key) => {
                (options.headers as Headers).set(key, value);
             });
        }

    } else {
        urlStr = input.toString();
        // If input is URL string, options just uses init
        options = { ...(init || {}) };
    }

    const targetOrigin = new URL(urlStr).origin;
    // Ensure account.pdsUrl is defined before using it
    if (!account.pdsUrl) {
         console.warn(`[agentFetchWithDpop] Account ${account.did} missing pdsUrl, using standard fetch for ${urlStr}`);
         return fetch(input, init); // Use original arguments
    }
    const pdsOrigin = new URL(account.pdsUrl).origin;

    // --- Only add DPoP for requests to the account's PDS --- 
    if (targetOrigin === pdsOrigin && account.dpopPrivateKeyJwk && account.dpopPublicKeyJwk) {
        console.log(`[agentFetchWithDpop] Adding DPoP for PDS request: ${urlStr}`);
        try {
            const privateKey = await jose.importJWK(account.dpopPrivateKeyJwk as jose.JWK, 'ES256');
            const publicJwk = account.dpopPublicKeyJwk as jose.JWK;
            const accessToken = account.accessJwt;
            let currentNonce = getServerNonce(targetOrigin);

            // --- BEGIN LOGGING ---
            console.log(`[agentFetchWithDpop DEBUG] Using access token: ${accessToken.substring(0, 10)}...${accessToken.substring(accessToken.length - 10)}`);
            console.log(`[agentFetchWithDpop DEBUG] Using private JWK: ${JSON.stringify(account.dpopPrivateKeyJwk).substring(0, 50)}...`);
            console.log(`[agentFetchWithDpop DEBUG] Using public JWK: ${JSON.stringify(account.dpopPublicKeyJwk).substring(0, 50)}...`);
            // --- END LOGGING ---

            // Attempt 1
            const dpopProof1 = await createDpopProof(urlStr, options.method || 'GET', privateKey, publicJwk, accessToken, currentNonce || undefined);
            // Create new Headers object based on existing options.headers
            const headers1 = new Headers(options.headers);
            headers1.set('Authorization', `DPoP ${accessToken}`);
            headers1.set('DPoP', dpopProof1);
            // Create a new options object for the fetch call
            const options1 = { ...options, headers: headers1 };

            // --- BEGIN LOGGING ---
            console.log(`[agentFetchWithDpop DEBUG Attempt 1] DPoP Proof: ${dpopProof1.substring(0,15)}...`);
            console.log(`[agentFetchWithDpop DEBUG Attempt 1] Headers:`, Object.fromEntries(headers1.entries()));
            // --- END LOGGING ---

            console.log(`[agentFetchWithDpop Attempt 1] Nonce: ${currentNonce ? 'Yes' : 'No'}`);
            let response = await fetch(urlStr, options1);
            console.log(`[agentFetchWithDpop Attempt 1] Status: ${response.status}`);

            const wwwAuthHeader = response.headers.get('www-authenticate');
            const responseNonce = response.headers.get('dpop-nonce');

            if (response.status === 401 && responseNonce && (wwwAuthHeader?.toLowerCase().includes('use_dpop_nonce') || !wwwAuthHeader)) {
                console.log(`[agentFetchWithDpop] Received new nonce: ${responseNonce}. Retrying.`);
                setServerNonce(targetOrigin, responseNonce);
                currentNonce = responseNonce;

                // Attempt 2
                const dpopProof2 = await createDpopProof(urlStr, options.method || 'GET', privateKey, publicJwk, accessToken, currentNonce);
                const headers2 = new Headers(options.headers); // Start with original headers again before modification
                headers2.set('Authorization', `DPoP ${accessToken}`);
                headers2.set('DPoP', dpopProof2);
                 // Create a new options object for the second fetch call
                const options2 = { ...options, headers: headers2 };

                // --- BEGIN LOGGING ---
                console.log(`[agentFetchWithDpop DEBUG Attempt 2] DPoP Proof: ${dpopProof2.substring(0,15)}...`);
                console.log(`[agentFetchWithDpop DEBUG Attempt 2] Headers:`, Object.fromEntries(headers2.entries()));
                // --- END LOGGING ---

                console.log(`[agentFetchWithDpop Attempt 2] Nonce: Yes`);
                response = await fetch(urlStr, options2);
                console.log(`[agentFetchWithDpop Attempt 2] Status: ${response.status}`);

                const finalNonce = response.headers.get('dpop-nonce');
                if (finalNonce && finalNonce !== currentNonce) {
                    console.log(`[agentFetchWithDpop] Nonce updated again after retry: ${finalNonce}`);
                    setServerNonce(targetOrigin, finalNonce);
                }
             } else if (responseNonce && responseNonce !== currentNonce) {
                 console.log(`[agentFetchWithDpop] Nonce updated on success: ${responseNonce}`);
                 setServerNonce(targetOrigin, responseNonce);
            }
            return response;

        } catch(dpopError) {
            console.error(`[agentFetchWithDpop] Error applying DPoP to ${urlStr}:`, dpopError);
            throw dpopError; // Re-throw DPoP specific errors
        }
    } else {
        // --- If not PDS URL or no DPoP keys, use standard fetch --- 
        if(targetOrigin === pdsOrigin) {
            console.warn(`[agentFetchWithDpop] Request to PDS ${urlStr} without DPoP keys present for account ${account.did}.`);
            // Potentially block this? Or allow but expect failures?
            // Allowing for now, might fail on server.
        }
        console.log(`[agentFetchWithDpop] Using standard fetch for: ${urlStr}`);
        return fetch(input, init); // Use original arguments
    }
}

// --- DID Resolution Helper ---
async function resolveDidToPdsUrl(did: string): Promise<string> {
    console.log(`[DID Resolver] Resolving DID: ${did}`);
    try {
        // Use a public PLC directory resolver
        const plcUrl = `https://plc.directory/${did}`;
        console.log(`[DID Resolver] Fetching DID document from: ${plcUrl}`);
        const response = await fetch(plcUrl);
        if (!response.ok) {
            throw new Error(`PLC directory fetch failed: ${response.status} ${response.statusText}`);
        }
        const didDoc = await response.json();
        console.log(`[DID Resolver] Received DID document structure for ${did}:`, JSON.stringify(didDoc, null, 2));
        
        let pdsUrl: string | undefined = undefined;
        
        // Manually iterate through services to find the correct PDS endpoint
        if (Array.isArray(didDoc?.service)) {
            for (const service of didDoc.service) {
                 // Explicitly check type and id
                 if (service && typeof service === 'object' && 
                     service.id === '#atproto_pds' &&
                     service.type === 'AtprotoPersonalDataServer' &&
                     typeof service.serviceEndpoint === 'string') 
                 {
                    pdsUrl = service.serviceEndpoint;
                    console.log(`[DID Resolver] Found PDS URL via manual iteration: ${pdsUrl}`);
                    break; // Stop searching once found
                 }
            }
        }
        
        // Check if we found the URL
        if (pdsUrl) {
            return pdsUrl;
        }
        
        // If loop finishes without finding it
        console.error(`[DID Resolver] Manual iteration failed to find 'AtprotoPersonalDataServer' service with id '#atproto_pds' and string endpoint in DID doc for ${did}`, didDoc);
        throw new Error('Could not find valid #atproto_pds service endpoint in DID document after manual check');
    } catch (error) {
        console.error(`[DID Resolver] Failed to resolve DID ${did}:`, error);
        // Fallback to bsky.social as a last resort, but log error prominently
        console.error(`[DID Resolver] CRITICAL: Falling back to ${BLUESKY_SERVICE} for DID ${did}. This may cause errors.`);
        return BLUESKY_SERVICE; 
    }
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

      // --- REMOVED: Handler for EXCHANGE_CODE --- 
      /*
      if (message.type === 'EXCHANGE_CODE') {
        // ... removed logic ...
        return true; 
      }
      */
      
      // --- NEW: Handler for GET_CODE_VERIFIER request from content script ---
      if (message.type === 'GET_CODE_VERIFIER') {
        const { state } = message.data || {};
        if (!state) {
          console.error('[Background][GET_CODE_VERIFIER] Missing state parameter');
          if (sendResponse) sendResponse({ success: false, error: 'Missing state parameter' });
          return false;
        }
        
        // Retrieve PKCE verifier from session storage
        (async () => {
          try {
            console.log(`[Background][GET_CODE_VERIFIER] Retrieving verifier for state: ${state.substring(0,5)}...`);
            const verifier = await retrieveAndClearPkceState(state);
            if (!verifier) {
              console.error(`[Background][GET_CODE_VERIFIER] No verifier found for state: ${state.substring(0,5)}...`);
              if (sendResponse) sendResponse({ success: false, error: 'Verifier not found or expired' });
              return;
            }
            
            console.log(`[Background][GET_CODE_VERIFIER] Retrieved verifier for state: ${state.substring(0,5)}...`);
            if (sendResponse) sendResponse({ success: true, verifier });
          } catch (err) {
            console.error('[Background][GET_CODE_VERIFIER] Error retrieving verifier:', err);
            if (sendResponse) sendResponse({ success: false, error: 'Error retrieving verifier' });
          }
        })();
        
        return true; // Indicate async response
      }
      
      // --- NEW: Handler for OAUTH_TOKEN_RECEIVED ---
      if (message.type === 'OAUTH_TOKEN_RECEIVED') {
        const tokenData = message.data; // Now includes tokens AND potentially DPoP JWKs
        
        // Validate basic token data AND DPoP keys
        if (!tokenData || !tokenData.access_token || !tokenData.refresh_token || 
            !tokenData.dpopPrivateKeyJwk || !tokenData.dpopPublicKeyJwk) { 
          console.error('[Background][OAUTH_TOKEN_RECEIVED] Invalid/incomplete token data received (missing tokens or DPoP JWKs):', tokenData);
          if (sendResponse) sendResponse({ success: false, error: 'Invalid token data received from auth server' });
          // Notify login page of failure
           browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: 'Invalid data from auth server' }).catch(()=>{});
          return false;
        }
        
        console.log('[Background][OAUTH_TOKEN_RECEIVED] Processing received tokens and DPoP keys');
        
        (async () => {
          // Extract the received DPoP JWKs
          const privateJwk = tokenData.dpopPrivateKeyJwk as object;
          const publicJwk = tokenData.dpopPublicKeyJwk as object;
          let resolvedPdsUrl: string | undefined = undefined;

          try {
            // NO LONGER generate keys here - use the ones from tokenData
            console.log('[Background][OAUTH_TOKEN_RECEIVED] Using DPoP keys received from auth server.');

            // --- Determine User DID --- 
            let userDid = '';
            let userHandle = ''; 
            // Priority 1: Check tokenData.sub
            if (tokenData.sub && typeof tokenData.sub === 'string') {
                userDid = tokenData.sub;
                console.log(`[Background][OAUTH_TOKEN_RECEIVED] Got DID from token response 'sub' field: ${userDid}`);
            } else {
                console.log('[Background][OAUTH_TOKEN_RECEIVED] DID not found in token response sub field. Trying JWT decode...');
                // Priority 2: Try decoding the access token JWT's 'sub' claim
                try {
                   const accessToken = tokenData.access_token;
                   const tokenParts = accessToken.split('.');
                   if (tokenParts.length === 3) {
                     const payloadBase64 = tokenParts[1];
                     const decodedText = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
                     const payload = JSON.parse(decodedText);
                     console.log('[Background][OAUTH_TOKEN_RECEIVED] Decoded JWT payload for fallback DID check:', payload);
                     if (payload.sub && typeof payload.sub === 'string') { 
                        userDid = payload.sub;
                        console.log(`[Background][OAUTH_TOKEN_RECEIVED] Got DID from JWT 'sub' claim (fallback): ${userDid}`);
                     }
                   }
                } catch (decodeErr) {
                    console.error('[Background][OAUTH_TOKEN_RECEIVED] Error decoding JWT for fallback DID check:', decodeErr);
                }
            }
            
            // If DID is still unknown after both checks, we cannot proceed
            if (!userDid) {
                console.error('[Background][OAUTH_TOKEN_RECEIVED] CRITICAL: Could not determine user DID from token response or JWT.', tokenData);
                throw new Error('Could not determine user DID from OAuth response.');
            }
            // --------------------------
            
            // Now that we definitely have a DID, resolve its PDS URL
            resolvedPdsUrl = await resolveDidToPdsUrl(userDid);
            
            // Fetch handle using describeRepo on the correct PDS URL.
            console.log(`[Background][OAUTH_TOKEN_RECEIVED] Fetching handle using describeRepo on resolved PDS: ${resolvedPdsUrl}`);
            
            const accountForPdsFetch: Account = {
                did: userDid,
                handle: 'unknown', 
                accessJwt: tokenData.access_token,
                refreshJwt: tokenData.refresh_token,
                dpopPrivateKeyJwk: privateJwk,
                dpopPublicKeyJwk: publicJwk,
                pdsUrl: resolvedPdsUrl 
            };
            const describeRepoUrl = `${resolvedPdsUrl}/xrpc/com.atproto.repo.describeRepo?repo=${userDid}`;
            
            try {
              // Bind the fetch function to the specific account context
              const boundFetch = agentFetchWithDpop.bind(accountForPdsFetch);
              // Call the bound fetch function with only URL and options
              const response = await boundFetch(describeRepoUrl, { method: 'GET' });
                if (response.ok) {
                const repoData = await response.json();
                if (repoData.handle) {
                  userHandle = repoData.handle;
                  console.log(`[Background][OAUTH_TOKEN_RECEIVED] Retrieved handle from describeRepo: ${userHandle}`);
                  // Optionally get email if present (describeRepo doesn't include email)
                  // We'd need to rely on the email possibly present in tokenData
                } else {
                  console.warn('[Background][OAUTH_TOKEN_RECEIVED] Handle still missing after describeRepo.');
                  userHandle = 'unknown.bsky.social'; // Fallback handle
                }
              } else {
                const errorText = await response.text();
                console.error('[Background][OAUTH_TOKEN_RECEIVED] describeRepo fetch failed on correct PDS:', response.status, errorText);
                 userHandle = 'unknown.bsky.social'; // Fallback handle
              }
            } catch (err) {
              console.error('[Background][OAUTH_TOKEN_RECEIVED] Error fetching repo info on correct PDS:', err);
                userHandle = 'unknown.bsky.social'; // Fallback handle
            }
            
            // Construct final account data with received JWKs
            const accountData: Account = {
              did: userDid,
              handle: userHandle,
              email: tokenData.email || '',
              accessJwt: tokenData.access_token,
              refreshJwt: tokenData.refresh_token,
              dpopPrivateKeyJwk: privateJwk, // Store received JWK
              dpopPublicKeyJwk: publicJwk,   // Store received JWK
              pdsUrl: resolvedPdsUrl // Store the resolved PDS URL
            };
            
            console.log(`[Background][OAUTH_TOKEN_RECEIVED] Saving account: ${accountData.handle} (${accountData.did}) PDS: ${accountData.pdsUrl}`);
            await saveAccount(accountData);
            
            // --- INSTEAD: Trigger re-initialization --- 
            console.log(`[Background][OAUTH_TOKEN_RECEIVED] Account ${accountData.handle} saved. Triggering re-initialization.`);
            // Call initializeAccounts directly, the flag will prevent the storage listener from running it again immediately
            initializeAccounts(); 
            // ---------------------------------------------
            
            // Send success response to content script
            if (sendResponse) sendResponse({ 
              success: true, 
              account: { did: accountData.did, handle: accountData.handle } 
            });
            
            // Notify login page that auth is complete
            browser.runtime.sendMessage({
              type: 'OAUTH_COMPLETE',
              success: true,
              account: { did: accountData.did, handle: accountData.handle }
            }).catch((e) => console.warn('[Background][OAUTH_TOKEN_RECEIVED] Failed to send OAUTH_COMPLETE message', e));
            
          } catch (err) {
            console.error('[Background][OAUTH_TOKEN_RECEIVED] Error processing tokens:', err);
            // Check if err is an Error object before accessing message
            const errorMsg = (err instanceof Error) ? err.message : 'An unknown error occurred.';
            if (sendResponse) sendResponse({ success: false, error: errorMsg });
            browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: errorMsg }).catch(e => console.warn('Failed to send error'));
          }
        })();
        
        return true; // Indicate async response
      }
      
      // --- UPDATED: Handler for OAUTH_CALLBACK from Auth Server Callback Page ---
      if (message.type === 'OAUTH_CALLBACK') {
        // Check if the message is from our specific auth server origin (more secure)
        // or from the extension itself (content script)
        const expectedOrigin = new URL(SERVER_REDIRECT_URI).origin; // e.g., "https://notisky.symm.app"
        const isFromExtension = sender.id === browser.runtime.id;
        
        // Accept messages from either the auth server or our own extension (content script)
        if (!isFromExtension && sender.origin !== expectedOrigin) {
          console.warn(`[Background][OAUTH_CALLBACK] Received message from unexpected origin: ${sender.origin}. Expected: ${expectedOrigin} or extension. Ignoring.`);
          // Optionally send error back? Or just ignore.
          if (sendResponse) sendResponse({ success: false, error: 'Invalid sender origin' });
          return false;
        }
        
        console.log(`[Background][OAUTH_CALLBACK] Received callback from ${isFromExtension ? 'extension content script' : 'Auth Server'}: ${sender.url}`);
        const { error, error_description } = message.data || {};

        // Handle errors passed from auth server callback page
        if (error) {
          console.error(`[Background][OAUTH_CALLBACK] Error received from callback: ${error} - ${error_description}`);
          // Send failure message to login page (which might be listening)
          browser.runtime.sendMessage({ type: 'OAUTH_COMPLETE', success: false, error: `OAuth Error: ${error_description || error}` }).catch(()=>{});
          if (sendResponse) sendResponse({ success: false, error: 'OAuth error received' });
          return false;
        }

        // This is now just an informational message, since code exchange happens in the auth server
        console.log('[Background][OAUTH_CALLBACK] Received callback info (exchange happens via auth server)');
        if (sendResponse) sendResponse({ success: true, message: 'Received notification of OAuth flow' });
        return false;
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

    // Storage change listener (updated)
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.accounts) {
        console.log('Account storage changed, scheduling re-initialization...');
        // Check the flag before initializing to prevent concurrent runs
        if (!isInitializing) {
             initializeAccounts().catch(error => {
               console.error('Failed to re-initialize accounts after storage change:', error);
             });
        } else {
            console.log('Initialization was already in progress, storage change noted but redundant init skipped.');
        }
      }
    });

    // Cleanup on extension uninstall (use defined constant)
    browser.runtime.setUninstallURL(UNINSTALL_URL);
  },

  // --- Programmatic injection removed ---
});

