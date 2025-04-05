import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { BrowserOAuthClient, type ClientMetadata } from '@atproto/oauth-client-browser';
import BskyAgent from '@atproto/api';
import { Account } from '../../src/services/auth'; // Adjust path as needed
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth'; // Adjust path for constants

// --- OAuth Configuration ---
const WEB_CALLBACK_URL = 'https://notisky.symm.app/oauth-callback.html';
const CLIENT_METADATA_URL = 'https://notisky.symm.app/public/client-metadata/client.json';
const TOKEN_ENDPOINT = `${BLUESKY_SERVICE}/oauth/token`;

// Client Metadata (for frontend instantiation)
const clientMetadata: ClientMetadata = {
  client_id: CLIENT_METADATA_URL, 
  client_name: 'Notisky', 
  client_uri: 'https://notisky.symm.app', 
  // Must match what's in the hosted client.json 
  redirect_uris: [WEB_CALLBACK_URL], 
  logo_uri: 'https://notisky.symm.app/icon/128.png',
  tos_uri: 'https://notisky.symm.app/terms',
  policy_uri: 'https://notisky.symm.app/privacy',
  contacts: ['notisky@symm.app'], 
  token_endpoint_auth_method: 'none', 
  grant_types: ['authorization_code', 'refresh_token'], 
  response_types: ['code'], 
  scope: 'atproto transition:generic transition:chat.bsky', 
  application_type: 'web', 
  dpop_bound_access_tokens: true 
};

// --- Helper Function to convert TOKEN RESPONSE to Account ---
// Note: This differs from the previous oauthSessionToAccount
async function tokenResponseToAccount(tokenData: any): Promise<Account | null> {
  try {
    // Basic validation of token response
    if (!tokenData || !tokenData.did || !tokenData.access_token || !tokenData.refresh_token) { 
      console.error('tokenResponseToAccount: Invalid token data structure:', tokenData);
      return null;
    }
    console.log(`tokenResponseToAccount: Processing tokens for DID: ${tokenData.did}`);
    // Use a temporary agent just to get the profile handle
    // We trust the DID from the token endpoint response
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.resumeSession({
        did: tokenData.did,
        accessJwt: tokenData.access_token,
        refreshJwt: tokenData.refresh_token,
        handle: 'temp.bsky.social' // Needs a placeholder
    });
     if (!agent.session?.did) {
        console.error('tokenResponseToAccount: BskyAgent did not initialize correctly.');
        return null; 
    }
    const { data: profile } = await agent.getProfile({ actor: agent.session.did });

    const account: Account = {
      did: agent.session.did, 
      handle: profile.handle, // Get handle from profile 
      refreshJwt: tokenData.refresh_token, // Use tokens from the direct response 
      accessJwt: tokenData.access_token,  
      email: profile.email 
    };
    console.log(`tokenResponseToAccount: Account created for handle: ${account.handle}`);
    return account;

  } catch (error) {
    console.error('tokenResponseToAccount: Error converting token response:', error);
    return null;
  }
}

// REMOVED Manual PKCE Helper functions

// --- Login Component --- 

function Login() {
  const [handle, setHandle] = useState(''); // Use 'handle' instead of 'username'
  // const [password, setPassword] = useState(''); // Password not needed for OAuth
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null); // For status updates

  // Effect to check for stored code when popup opens/reloads
  useEffect(() => {
    const checkForOAuthCode = async () => {
      console.log('Login component mounted/reloaded, checking for OAuth code...');
      setLoading(true);
      setInfo('Checking authentication status...');
      try {
        const response = await browser.runtime.sendMessage({ type: 'GET_OAUTH_CODE' });
        if (response && response.success && response.data?.code) {
          console.log('OAuth code found, attempting token exchange.', response.data);
          setInfo('Authentication code received, exchanging for tokens...');
          setError(null);

          const { code, state } = response.data;

          // ** Retrieve the code_verifier stored by BrowserOAuthClient **
          // The key usually involves the state. Trying a common pattern.
          // IMPORTANT: Verify this key format by inspecting localStorage after signIn redirect!
          const verifierKey = `com.atproto.oauth.pkce.code_verifier.${state}`;
          const codeVerifier = localStorage.getItem(verifierKey);

          if (!codeVerifier) {
            console.error(`FATAL: PKCE code_verifier not found in localStorage for key: ${verifierKey}`);
            // Attempt fallback keys?
            const fallbackKey1 = `pkce_code_verifier_${state}`;
            const fallbackKey2 = `oauth_pkce_verifier_${state}`;
            const fallbackVerifier = localStorage.getItem(fallbackKey1) || localStorage.getItem(fallbackKey2);
             if (!fallbackVerifier) {
                setError('Security code missing (verifier). Please try logging in again.');
                setInfo(null);
                setLoading(false);
                return;
             } else {
                console.warn(`Used fallback key to find PKCE verifier: ${fallbackKey1} or ${fallbackKey2}`);
                localStorage.removeItem(fallbackKey1);
                localStorage.removeItem(fallbackKey2);
                // codeVerifier = fallbackVerifier; // Reassign if necessary - logic implies we use fallback directly
                 // Exchange code for token using fallbackVerifier
                 const tokenResponse = await fetch(TOKEN_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code: code,
                        redirect_uri: WEB_CALLBACK_URL,
                        client_id: clientMetadata.client_id,
                        code_verifier: fallbackVerifier
                    }).toString()
                });
                 const tokenData = await tokenResponse.json();
                 if (!tokenResponse.ok) throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed (fallback verifier)');
                 // Process tokenData...
                 const account = await tokenResponseToAccount(tokenData);
                 if (account) {
                    setInfo(`Welcome ${account.handle}! Finalizing login...`);
                    await browser.runtime.sendMessage({ type: 'ACCOUNT_ADDED', data: { account } });
                    console.log('ACCOUNT_ADDED message sent after token exchange (fallback verifier).');
                    setTimeout(() => window.close(), 1500);
                 } else {
                    setError('Failed to process token data after exchange (fallback verifier).');
                    setInfo(null);
                 }
                 setLoading(false);
                 return; // Exit after successful fallback processing
             }
          }
          
          // Found verifier with primary key
          console.log('Found PKCE verifier using key:', verifierKey);
          localStorage.removeItem(verifierKey); // Clean up verifier

          // Exchange code for token using primary verifier
          const tokenResponse = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: WEB_CALLBACK_URL,
              client_id: clientMetadata.client_id, 
              code_verifier: codeVerifier
            }).toString()
          });

          const tokenData = await tokenResponse.json();

          if (!tokenResponse.ok) {
            console.error('Token exchange failed:', tokenData);
            throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
          }
          
          if (!tokenData.did) {
                console.warn('Token response did not include DID.');
          }

          const account = await tokenResponseToAccount(tokenData); 

          if (account) {
            setInfo(`Welcome ${account.handle}! Finalizing login...`);
            await browser.runtime.sendMessage({
                type: 'ACCOUNT_ADDED',
                data: { account }
            });
            console.log('ACCOUNT_ADDED message sent after token exchange.');
            setTimeout(() => window.close(), 1500);
          } else {
            setError('Failed to process token data after exchange.');
            setInfo(null);
          }

        } else {
          // No code found or background script reported error
          console.log('No pending OAuth code found.');
          if (response && !response.success) {
            setError(response.error || 'Failed to retrieve auth code.');
          }
          setInfo(null); // Clear any loading messages
        }
      } catch (err: any) {
        console.error('Error during OAuth code check/exchange:', err);
        setError(`Login failed: ${err.message || err}`);
        setInfo(null);
      } finally {
        setLoading(false);
      }
    };

    checkForOAuthCode();
  }, []); 

  // Handle initiating the OAuth sign-in flow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('handleOAuthLogin started');
    if (!handle) {
      setError('Please enter your Bluesky handle (e.g., yourname.bsky.social).');
      return;
    }
    setError(null);
    setInfo('Redirecting to Bluesky for login...'); 
    setLoading(true);
    
    try {
        const state = crypto.randomUUID(); 
        console.log('Generated state for OAuth flow:', state);
        
        console.log('Creating BrowserOAuthClient...'); 
        const oauthClient = new BrowserOAuthClient({ 
            clientMetadata, 
            handleResolver: BLUESKY_SERVICE, 
            responseMode: 'fragment' 
        });
        
        console.log('Calling oauthClient.signIn() with state (no await)...');
        // Let the client handle PKCE generation/storage and redirect
        // Try removing await to see if it prevents the "User navigated back" error
        oauthClient.signIn(handle.trim(), { state });
        
        // We expect the redirect to happen immediately, so reaching here is unlikely
        // unless there's an immediate synchronous error before navigation starts.
        console.log('Called signIn, waiting for redirect...'); 

    } catch (err: any) {
      // This catch block might only catch synchronous errors now
      console.error('OAuth signIn initiation sync error:', err); 
      setError(`Failed to start login: ${err.message || err}`);
      setLoading(false);
      setInfo(null);
    }
    // Keep loading=true assuming redirect will happen
  };
  
  const handleSubmit = handleOAuthLogin; 

  return (
    <div className="login-container">
      <div className="login-header">
        {/* App Logo can go here */} 
        <img src="../icon/128.png" alt="Notisky Logo" style={{width: 48, height: 48, marginBottom: 10}}/>
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      
      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>} {/* Added info message */} 
        
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
        
        {/* Password field removed */}
        
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
          You will be redirected to Bluesky to authorize Notisky.
          Your password is never shared with this extension.
        </p>
      </div>
    </div>
  );
}

export default Login; 