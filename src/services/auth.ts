import BskyAgent from '@atproto/api';
import { Account } from './auth'; // Self-import is okay for type definition

export interface Account {
  did: string;
  handle: string;
  email?: string;
  refreshJwt: string; // Must be stored securely
  accessJwt: string;  // Must be stored securely
}

const BLUESKY_SERVICE = 'https://bsky.social';
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;

// Client ID for token refresh - Using the extension ID might be required by some PDS
// Or maybe a specific client ID if registered. Using extension ID as a placeholder.
// NOTE: This needs clarification based on ATProto OAuth spec for refresh grants.
// For now, assume no client_id needed or use a placeholder/extension ID.
// const CLIENT_ID_FOR_REFRESH = browser.runtime.id; // Example

/**
 * Refreshes an account's access token using the refresh token.
 * This function should be called by the background script when an API call fails due to an expired token.
 */
export async function refreshToken(account: Account): Promise<Account | null> {
  console.log(`Attempting to refresh token for ${account.handle} (${account.did})`);
  try {
    // Use the refresh token to get a new access token
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshJwt,
        // client_id: CLIENT_ID_FOR_REFRESH // Include if required by the OAuth server
      }).toString()
    });

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
    if (!account || !account.did || !account.handle || !account.accessJwt || !account.refreshJwt) {
      console.error('Attempted to save invalid account structure:', account);
      return; // Do not save invalid account
    }
    accounts[account.did] = account;
    await browser.storage.local.set({ accounts });
    console.log(`Account saved/updated for ${account.did}`);
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

// REMOVED createOAuthUrl and handleOAuthCallback as they belong in UI context 