import { BskyAgent } from '@atproto/api';

export interface Account {
  did: string;
  handle: string;
  email?: string;
  refreshJwt: string;
  accessJwt: string;
}

const BLUESKY_SERVICE = 'https://bsky.social';

/**
 * Creates the OAuth URL for Bluesky authentication
 */
export async function createOAuthUrl(): Promise<string> {
  // Generate a random state to verify the callback
  const state = Math.random().toString(36).substring(2, 15);
  
  // Store the state in local storage to verify later
  await browser.storage.local.set({ oauthState: state });
  
  // Get the redirect URL from the extension
  const redirectUri = browser.identity.getRedirectURL();
  
  // Create the OAuth URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: browser.runtime.id,
    redirect_uri: redirectUri,
    scope: 'com.atproto.notification:read',
    state
  });
  
  return `${BLUESKY_SERVICE}/oauth/authorize?${params.toString()}`;
}

/**
 * Handles the OAuth callback and exchanges the code for tokens
 */
export async function handleOAuthCallback(url: string): Promise<Account | null> {
  try {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    
    const code = params.get('code');
    const state = params.get('state');
    
    // Verify state
    const { oauthState } = await browser.storage.local.get('oauthState');
    if (!code || state !== oauthState) {
      throw new Error('Invalid OAuth callback');
    }
    
    // Clear the state
    await browser.storage.local.remove('oauthState');
    
    // Exchange the code for tokens
    const redirectUri = browser.identity.getRedirectURL();
    const tokenResponse = await fetch(`${BLUESKY_SERVICE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: browser.runtime.id,
        redirect_uri: redirectUri
      }).toString()
    });
    
    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      throw new Error(`Token exchange failed: ${errorData.error || 'Unknown error'}`);
    }
    
    const tokens = await tokenResponse.json();
    
    // Use the tokens to create a session
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.resumeSession({
      refreshJwt: tokens.refresh_token,
      accessJwt: tokens.access_token
    });
    
    // Get user info
    const { data: profile } = await agent.getProfile({ actor: agent.session?.did! });
    
    const account: Account = {
      did: agent.session?.did!,
      handle: profile.handle,
      refreshJwt: tokens.refresh_token,
      accessJwt: tokens.access_token,
      email: profile.email
    };
    
    // Save the account
    await saveAccount(account);
    
    return account;
  } catch (error) {
    console.error('OAuth error:', error);
    return null;
  }
}

/**
 * Refreshes an account's access token
 */
export async function refreshToken(account: Account): Promise<Account | null> {
  try {
    // Use the refresh token to get a new access token
    const tokenResponse = await fetch(`${BLUESKY_SERVICE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshJwt,
        client_id: browser.runtime.id
      }).toString()
    });
    
    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      throw new Error(`Token refresh failed: ${errorData.error || 'Unknown error'}`);
    }
    
    const tokens = await tokenResponse.json();
    
    // Create an agent with the new tokens
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.resumeSession({
      refreshJwt: tokens.refresh_token,
      accessJwt: tokens.access_token
    });
    
    // Update the account with the new tokens
    const updatedAccount: Account = {
      ...account,
      refreshJwt: tokens.refresh_token,
      accessJwt: tokens.access_token
    };
    
    // Save the updated account
    await saveAccount(updatedAccount);
    
    return updatedAccount;
  } catch (error) {
    console.error('Error refreshing token', error);
    return null;
  }
}

/**
 * Saves an account to storage
 */
export async function saveAccount(account: Account): Promise<void> {
  const { accounts = {} } = await browser.storage.local.get('accounts');
  
  accounts[account.did] = account;
  
  await browser.storage.local.set({ accounts });
}

/**
 * Loads all saved accounts from storage
 */
export async function loadAccounts(): Promise<Record<string, Account>> {
  const { accounts = {} } = await browser.storage.local.get('accounts');
  return accounts;
}

/**
 * Removes an account from storage
 */
export async function removeAccount(did: string): Promise<void> {
  const { accounts = {} } = await browser.storage.local.get('accounts');
  
  delete accounts[did];
  
  await browser.storage.local.set({ accounts });
} 