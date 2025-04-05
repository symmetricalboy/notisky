import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { BskyAgent } from '@atproto/api';
import { Account } from './auth';
import { browser } from 'wxt/browser';

// Constants
export const BLUESKY_SERVICE = 'https://bsky.social';

// Define a fallback redirect URI
const FALLBACK_REDIRECT_URI = 'https://notisky.symm.app/redirect.html';

// Safely get redirect URL, with a fallback for build-time and environments
// where browser.identity might not be available
const getRedirectURL = () => {
  try {
    if (browser.identity && typeof browser.identity.getRedirectURL === 'function') {
      return browser.identity.getRedirectURL();
    }
  } catch (error) {
    console.warn('Could not get redirect URL from browser.identity, using fallback');
  }
  
  return FALLBACK_REDIRECT_URI;
};

// Our client metadata
const clientMetadata = {
  client_id: 'https://notisky.symm.app/client-metadata/client.json',
  client_name: 'Notisky',
  client_uri: 'https://notisky.symm.app',
  redirect_uris: [getRedirectURL()],
  logo_uri: 'https://notisky.symm.app/icon/128.png',
  tos_uri: 'https://notisky.symm.app/terms',
  policy_uri: 'https://notisky.symm.app/privacy',
  software_id: 'notisky',
  software_version: '1.0.0',
  contacts: ['notisky@symm.app'],
  description: 'Real-time notifications for Bluesky',
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'atproto transition:generic transition:chat.bsky',
  application_type: 'web',
  dpop_bound_access_tokens: true
};

// Initialize the OAuth client
export const oauthClient = new BrowserOAuthClient({
  clientMetadata,
  handleResolver: BLUESKY_SERVICE,
  responseMode: 'fragment'
});

// Initialize the OAuth client and check for existing sessions
export async function initializeOAuth() {
  try {
    const result = await oauthClient.init();
    if (result) {
      const { session } = result;
      console.log(`OAuth session initialized for ${session.sub}`);
      return session;
    }
    return null;
  } catch (error) {
    console.error('Error initializing OAuth client', error);
    return null;
  }
}

// Start OAuth sign-in flow with a user handle
export async function startOAuthSignIn(handle: string) {
  try {
    // Store state information if needed
    const state = Math.random().toString(36).substring(2, 15);
    await browser.storage.local.set({ oauthState: state });
    
    // Start the sign-in process
    await oauthClient.signIn(handle, { 
      state,
      responseMode: 'fragment'
    });
    
    // This line won't execute because signIn redirects the user
    return null;
  } catch (error) {
    console.error('OAuth sign-in error:', error);
    return null;
  }
}

// Convert OAuth session to our Account type
export async function oauthSessionToAccount(session: any): Promise<Account | null> {
  try {
    // Create an agent with the session
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.resumeSession({
      refreshJwt: session.refresh_token,
      accessJwt: session.access_token
    });
    
    // Get user info
    const { data: profile } = await agent.getProfile({ actor: session.sub });
    
    // Create our account object
    const account: Account = {
      did: session.sub,
      handle: profile.handle,
      refreshJwt: session.refresh_token,
      accessJwt: session.access_token,
      email: profile.email
    };
    
    return account;
  } catch (error) {
    console.error('Error converting OAuth session to account', error);
    return null;
  }
}

// Refresh token using the OAuth client
export async function refreshOAuthToken(account: Account): Promise<Account | null> {
  try {
    // Get the session for this account
    const session = await oauthClient.restore(account.did);
    
    // Convert updated session to account
    return await oauthSessionToAccount(session);
  } catch (error) {
    console.error('Error refreshing OAuth token', error);
    return null;
  }
}

// Listen for session events
export function setupOAuthListeners(callback: (event: CustomEvent) => void) {
  oauthClient.addEventListener('deleted', callback);
} 