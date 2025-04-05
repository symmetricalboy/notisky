import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
// BrowserOAuthClient might not be needed anymore, but keep type for metadata
import { type ClientMetadata } from '@atproto/oauth-client-browser'; 
import BskyAgent from '@atproto/api'; // Linter ignored
import { Account } from '../../src/services/auth'; 
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth';

// --- OAuth Configuration ---
const WEB_CALLBACK_URL = 'https://notisky.symm.app/public/oauth-callback.html';
const CLIENT_METADATA_URL = 'https://notisky.symm.app/public/client-metadata/client.json';
const AUTHORIZATION_ENDPOINT = `${BLUESKY_SERVICE}/oauth/authorize`; // Need auth endpoint

// Client Metadata (matching hosted file)
const clientMetadata: ClientMetadata = {
  client_id: CLIENT_METADATA_URL, 
  client_name: 'Notisky', 
  client_uri: 'https://notisky.symm.app', 
  redirect_uris: [WEB_CALLBACK_URL], 
  logo_uri: 'https://notisky.symm.app/icon/128.png',
  tos_uri: 'https://notisky.symm.app/terms',
  policy_uri: 'https://notisky.symm.app/privacy',
  contacts: ['notisky@symm.app'], 
  token_endpoint_auth_method: 'none', 
  grant_types: ['authorization_code', 'refresh_token'], 
  response_types: ['code'], // We request code
  scope: 'atproto transition:generic transition:chat.bsky', 
  application_type: 'web', 
  dpop_bound_access_tokens: true 
};

// REMOVED tokenResponseToAccount helper (moved to auth.ts)

// PKCE Helper functions (needed for launchWebAuthFlow)
async function generateCodeVerifier(): Promise<string> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...randomBytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// --- Helper Function (Moved back / recreated for UI context) ---
async function oauthSessionToAccount(session: any): Promise<Account | null> {
  try {
    if (!session || typeof session.sub !== 'string' || 
        typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') { 
      console.error('oauthSessionToAccount: Invalid session structure:', session);
      return null;
    }
    console.log(`oauthSessionToAccount: Converting session for DID: ${session.sub}`);
    const agent = new BskyAgent({ 
      service: BLUESKY_SERVICE,
      session: session // Pass the session received from oauthClient.init()
    });
    if (!agent.session?.did || agent.session.did !== session.sub) {
        console.error('oauthSessionToAccount: BskyAgent did not initialize correctly.');
        // If agent didn't init, try getting profile directly with DID from session
        try {
            const fallbackAgent = new BskyAgent({ service: BLUESKY_SERVICE });
            const { data: profile } = await fallbackAgent.getProfile({ actor: session.sub });
            const account: Account = {
              did: session.sub, 
              handle: profile.handle, 
              refreshJwt: session.refresh_token, // Use tokens from original session
              accessJwt: session.access_token,  
              email: profile.email 
            };
            console.warn('Agent init failed, but created Account via fallback profile fetch.');
            return account;
        } catch (fallbackError) {
             console.error('oauthSessionToAccount: Failed to init agent AND fallback profile fetch failed:', fallbackError);
             return null; 
        }
    }
    // Agent initialized correctly, proceed as normal
    const { data: profile } = await agent.getProfile({ actor: agent.session.did });
    const account: Account = {
      did: agent.session.did, 
      handle: profile.handle, 
      refreshJwt: agent.session.refreshJwt!, // Use tokens from potentially refreshed agent session
      accessJwt: agent.session.accessJwt!,  
      email: profile.email 
    };
    console.log(`oauthSessionToAccount: Account created for handle: ${account.handle}`);
    return account;
  } catch (error) {
    console.error('oauthSessionToAccount: Error converting session:', error);
    return null;
  }
}

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // REMOVED useEffect hook for checking code on load

  // Handle initiating the OAuth sign-in flow using launchWebAuthFlow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[launchWebAuthFlow] Started');
    if (!handle) {
      setError('Please enter your Bluesky handle (e.g., yourname.bsky.social).');
      return;
    }
    setError(null);
    setInfo('Preparing secure login...');
    setLoading(true);
    let generatedState = null; // Keep state for potential cleanup
    
    try {
        const state = crypto.randomUUID();
        generatedState = state; // Store for potential cleanup
        const codeVerifier = await generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const codeChallengeMethod = 'S256';

        const verifierStorageKey = `oauth_pkce_verifier_${state}`;
        localStorage.setItem(verifierStorageKey, codeVerifier);
        console.log('[launchWebAuthFlow] Stored PKCE verifier for state:', state);

        const authParams = new URLSearchParams({
            response_type: 'code',
            client_id: clientMetadata.client_id,
            redirect_uri: WEB_CALLBACK_URL,
            scope: clientMetadata.scope!,
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
        });
        const authorizationUrl = `${AUTHORIZATION_ENDPOINT}?${authParams.toString()}`;
        console.log('[launchWebAuthFlow] Constructed Auth URL:', authorizationUrl);

        setInfo('Waiting for Bluesky authorization...');
        console.log('[launchWebAuthFlow] Calling browser.identity.launchWebAuthFlow...'); // <<< Log before call
        
        const resultUrl = await browser.identity.launchWebAuthFlow({
            url: authorizationUrl,
            interactive: true
        });

        console.log('[launchWebAuthFlow] Call finished. Result URL:', resultUrl); // <<< Log after call

        // --- Process Result URL --- 
        if (!resultUrl) {
            // This happens if the user closes the auth window manually
            console.log('[launchWebAuthFlow] Flow cancelled by user (no result URL).')
            throw new Error('Authentication flow was cancelled.');
        }

        const url = new URL(resultUrl);
        const fragmentParams = new URLSearchParams(url.hash.substring(1));
        const code = fragmentParams.get('code');
        const returnedState = fragmentParams.get('state');
        const errorCode = fragmentParams.get('error');
        const errorDesc = fragmentParams.get('error_description');

        if (errorCode) {
             console.error('[launchWebAuthFlow] OAuth Error in callback URL:', errorCode, errorDesc);
             throw new Error(`OAuth Error: ${errorDesc || errorCode}`);
        }
        if (!code) {
            console.error('[launchWebAuthFlow] Code not found in callback URL fragment:', url.hash);
            throw new Error('Authorization code not found in callback URL.');
        }
        if (returnedState !== state) {
             localStorage.removeItem(verifierStorageKey); 
             console.error('[launchWebAuthFlow] State mismatch! Expected:', state, 'Received:', returnedState);
             throw new Error('OAuth state mismatch. Security check failed.');
        }

        // --- Retrieve Verifier --- 
        console.log('[launchWebAuthFlow] State matches. Retrieving verifier...');
        const storedVerifier = localStorage.getItem(verifierStorageKey);
        localStorage.removeItem(verifierStorageKey); 
        if (!storedVerifier) {
             console.error('[launchWebAuthFlow] Verifier not found in localStorage for key:', verifierStorageKey);
             throw new Error('PKCE verifier not found after callback. Please try again.');
        }

        // --- Send to Background --- 
        setInfo('Authentication approved! Finalizing login...');
        console.log('[launchWebAuthFlow] Sending code and verifier to background...');
        const exchangeResponse = await browser.runtime.sendMessage({
            type: 'EXCHANGE_OAUTH_CODE',
            data: { code, state: returnedState, codeVerifier: storedVerifier }
        });

        // --- Handle Background Response --- 
        console.log('[launchWebAuthFlow] Received response from background:', exchangeResponse);
        if (exchangeResponse && exchangeResponse.success) {
            console.log('Background reported successful exchange.');
            setInfo('Login successful!');
            setTimeout(() => window.close(), 1500);
        } else {
             console.error('[launchWebAuthFlow] Background reported error:', exchangeResponse?.error);
             throw new Error(exchangeResponse?.error || 'Token exchange failed in background.');
        }

    } catch (err: any) {
      console.error('[launchWebAuthFlow] Overall flow error:', err); // <<< Log in catch block
      // Check for specific cancellation errors
      if (err.message?.includes('cancelled') || err.message?.includes('closed by the user')) {
           setError('Login cancelled.');
      } else {
           setError(`Login failed: ${err.message || 'Unknown error'}`);
      }
      // Clean up verifier if state was generated and error occurred
      if (generatedState) localStorage.removeItem(`oauth_pkce_verifier_${generatedState}`);
      setLoading(false);
      setInfo(null);
    }
  };
  
  const handleSubmit = handleOAuthLogin; 

  return (
    <div className="login-container">
      <div className="login-header">
        <img src="../icon/128.png" alt="Notisky Logo" style={{width: 48, height: 48, marginBottom: 10}}/>
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      
      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>}
        
        <div className="form-group">
          <label htmlFor="handle">Bluesky Handle</label>
          <input
            type="text"
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="yourname.bsky.social"
            required
            disabled={loading}
            autoCapitalize="none"
            autoCorrect="false"
          />
        </div>
                
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
          A new window will open to authorize Notisky with Bluesky.
        </p>
      </div>
    </div>
  );
}

export default Login; 