import { BskyAgent } from '@atproto/api';

export interface Account {
  did: string;
  handle: string;
  email?: string;
  refreshJwt: string; // Must be stored securely
  accessJwt: string;  // Must be stored securely
  dpopPrivateKeyJwk?: object; // Store exported private key JWK
  dpopPublicKeyJwk?: object;  // Store exported public key JWK
  pdsUrl?: string; // Store the user's PDS endpoint URL
}

const BLUESKY_SERVICE = 'https://bsky.social';
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;

// Client ID for token refresh - Using the extension ID might be required by some PDS
// Or maybe a specific client ID if registered. Using extension ID as a placeholder.
// NOTE: This needs clarification based on ATProto OAuth spec for refresh grants.
// For now, assume no client_id needed or use a placeholder/extension ID.
const CLIENT_ID_FOR_REFRESH = browser.runtime.id;

/**
 * Refreshes an account's access token using the refresh token.
 * This function should be called by the background script when an API call fails due to an expired token.
 */
export async function refreshToken(account: Account): Promise<Account | null> {
  console.log(`Attempting to refresh token for ${account.handle} (${account.did})`);
  try {
    // Get the DPoP functions from the background script
    const background = (browser.extension.getBackgroundPage() as any);
    const generateDpopKeyPair = background.generateDpopKeyPair;
    const createDpopProof = background.createDpopProof;
    const dpopServerNonce = background.dpopServerNonce;

    // Prepare the refresh token request body
    const refreshParams = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshJwt,
      client_id: CLIENT_ID_FOR_REFRESH
    });

    // Generate a new DPoP key for this refresh
    const keyPair = await generateDpopKeyPair();
    
    // Create the DPoP proof
    const dpopProof = await createDpopProof(TOKEN_ENDPOINT, 'POST', keyPair, dpopServerNonce);

    // Make the request with DPoP 
    let response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'DPoP': dpopProof
      },
      body: refreshParams.toString()
    });

    // Handle 401 with DPoP nonce
    if (response.status === 401) {
      const nonce = response.headers.get('DPoP-Nonce');
      if (nonce) {
        console.log(`Received DPoP nonce during refresh: ${nonce}, retrying...`);
        // Update the nonce in background
        background.dpopServerNonce = nonce;
        // Create a new proof with the nonce
        const newDpopProof = await createDpopProof(TOKEN_ENDPOINT, 'POST', keyPair, nonce);
        
        // Retry the request
        response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'DPoP': newDpopProof
          },
          body: refreshParams.toString()
        });
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown refresh error', description: response.statusText }));
      console.error(`Token refresh failed (${response.status}) for ${account.did}:`, errorData);
      // If refresh fails (e.g., invalid grant), the refresh token might be revoked.
      // Consider removing the account or marking it as needing re-login.
      if (response.status === 400 || response.status === 401) {
        console.warn(`Refresh token likely revoked for ${account.did}. Removing account.`);
        await removeAccount(account.did); // Remove account on fatal refresh error
        return null; // Indicate failure and removal
      }
      throw new Error(`Token refresh failed: ${errorData.error || 'Unknown error'} - ${errorData.description || 'No description'}`);
    }

    const tokens = await response.json();

    // Validate new tokens
    if (!tokens.access_token || !tokens.refresh_token) {
        console.error('Token refresh response missing required tokens for', account.did, tokens);
        throw new Error('Invalid token response received from refresh endpoint');
    }

    // Update the account with the new tokens
    const updatedAccount: Account = {
      ...account,
      accessJwt: tokens.access_token,
      refreshJwt: tokens.refresh_token // Update refresh token if a new one is issued
    };

    console.log(`Token refreshed successfully for ${account.did}`);

    // Save the updated account with new tokens
    await saveAccount(updatedAccount);

    return updatedAccount;
  } catch (error) {
    console.error('Error during token refresh process for', account.did, error);
    return null; // Indicate failure
  }
}

/**
 * Saves an account to storage
 */
export async function saveAccount(account: Account): Promise<void> {
  try {
    const { accounts = {} } = await browser.storage.local.get('accounts');
    // Basic validation before saving
    if (!account || !account.did || !account.handle || !account.accessJwt || !account.refreshJwt || !account.pdsUrl) {
      console.error('Attempted to save invalid or incomplete account structure:', account);
      return; // Do not save invalid account
    }
    // Ensure DPoP keys are included if present
    const accountToSave: Account = { ...account };
    if (!account.dpopPrivateKeyJwk || !account.dpopPublicKeyJwk) {
        // If keys are missing log a warning, but allow saving
        console.warn(`Account ${account.did} being saved without full DPoP keys.`);
        // Allow saving even without DPoP keys for now, but PDS URL is mandatory
    }

    accounts[account.did] = accountToSave;
    await browser.storage.local.set({ accounts });
    console.log(`Account saved/updated for ${account.did} (PDS: ${account.pdsUrl})`);
  } catch (error) {
    console.error('Error saving account', account.did, error);
  }
}

/**
 * Loads all saved accounts from storage
 */
export async function loadAccounts(): Promise<Record<string, Account>> {
  try {
    const { accounts = {} } = await browser.storage.local.get('accounts');
    // Optional: Add validation here to filter out malformed accounts during load
    console.log('Accounts loaded from storage:', Object.keys(accounts));
    return accounts;
  } catch (error) {
    console.error('Error loading accounts', error);
    return {}; // Return empty object on error
  }
}

/**
 * Removes an account from storage
 */
export async function removeAccount(did: string): Promise<void> {
  try {
    const { accounts = {} } = await browser.storage.local.get('accounts');
    if (accounts[did]) {
      delete accounts[did];
      await browser.storage.local.set({ accounts });
      console.log(`Account removed for ${did}`);
    } else {
      console.warn(`Attempted to remove non-existent account: ${did}`);
    }
  } catch (error) {
    console.error('Error removing account', did, error);
  }
}

/**
 * Converts raw token data (from token endpoint response) into an Account object.
 * Fetches profile data to get the handle.
 */
export async function tokenResponseToAccount(tokenData: any): Promise<Account | null> {
  try {
    if (!tokenData || !tokenData.did || !tokenData.access_token || !tokenData.refresh_token) { 
      console.error('tokenResponseToAccount: Invalid token data structure:', tokenData);
      return null;
    }
    console.log(`tokenResponseToAccount: Processing tokens for DID: ${tokenData.did}`);
    
    // Use a temporary agent to get the profile handle
    const agent: InstanceType<typeof BskyAgent> = new BskyAgent({ service: BLUESKY_SERVICE });
    // Resume session using the *newly obtained* tokens and the DID from the token response
    await agent.resumeSession({
        did: tokenData.did,
        accessJwt: tokenData.access_token, // Use the NEW access token
        refreshJwt: tokenData.refresh_token, // Use the NEW refresh token
        handle: 'temp.bsky.social' // Placeholder needed for resumeSession
    });

     if (!agent.session?.did) {
        console.error('tokenResponseToAccount: BskyAgent did not initialize correctly after token exchange.');
        return null; 
    }
    
    // Fetch profile using the now authenticated agent
    // @ts-ignore
    const { data: profile } = await agent.getProfile({ actor: agent.session.did });

    // Create the final Account object
    const account: Account = {
      did: agent.session.did, 
      handle: profile.handle, // Get handle from profile 
      refreshJwt: tokenData.refresh_token, // Store the tokens from the response
      accessJwt: tokenData.access_token,  
      email: profile.email as string | undefined, // Cast to the correct type
      dpopPrivateKeyJwk: agent.session.dpopPrivateKeyJwk, // Include DPoP key
      dpopPublicKeyJwk: agent.session.dpopPublicKeyJwk, // Include DPoP key
      pdsUrl: profile.pdsUrl as string | undefined, // Include PDS URL from profile
    };
    console.log(`tokenResponseToAccount: Account created/updated for handle: ${account.handle}`);
    return account;

  } catch (error) {
    console.error('tokenResponseToAccount: Error converting token response:', error);
    return null;
  }
}

// REMOVED createOAuthUrl and handleOAuthCallback as they belong in UI context 