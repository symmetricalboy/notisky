import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { BrowserOAuthClient, type ClientMetadata } from '@atproto/oauth-client-browser';
import BskyAgent from '@atproto/api'; // Linter ignored
import { Account } from '../../src/services/auth'; 
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth';

// --- OAuth Configuration ---

// Fallback Redirect URI (Only used if browser.identity fails)
const FALLBACK_REDIRECT_URI = 'https://notisky.symm.app/redirect.html'; // Or maybe a specific error page?

// Safely get redirect URL (Using browser identity API)
const getRedirectURL = (): string => {
  try {
    if (browser.identity && typeof browser.identity.getRedirectURL === 'function') {
      const url = browser.identity.getRedirectURL();
      // Basic validation: Should start with https:// and contain the extension ID pattern
      if (url && url.startsWith('https://') && url.includes('.chromiumapp.org')) { // Adjust domain for other browsers if needed
        console.log('Login UI: Using redirect URL from browser.identity:', url);
        return url;
      }
      console.warn('Login UI: browser.identity.getRedirectURL() returned invalid value:', url, 'Using fallback.');
    } else {
        console.warn('Login UI: browser.identity.getRedirectURL is not available. Using fallback.');
    }
  } catch (error) {
    console.warn('Login UI: Error getting redirect URL from browser.identity, using fallback:', error);
  }
  console.log('Login UI: Using fallback redirect URL:', FALLBACK_REDIRECT_URI);
  return FALLBACK_REDIRECT_URI;
};

const EXTENSION_REDIRECT_URL = getRedirectURL(); // Get the actual extension redirect URL
const CLIENT_METADATA_URL = 'https://notisky.symm.app/public/client-metadata/client.json'; // Hosted metadata URL

// Client Metadata (Embedded in the client)
const clientMetadata: ClientMetadata = {
  // Point client_id to the hosted metadata URL (Bluesky server needs to fetch this)
  client_id: CLIENT_METADATA_URL as any, 
  client_name: 'Notisky', 
  client_uri: 'https://notisky.symm.app' as any, 
  // IMPORTANT: Use the extension's actual redirect URI here
  redirect_uris: [EXTENSION_REDIRECT_URL] as any, 
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

// REMOVED tokenResponseToAccount helper (moved to auth.ts)

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
      session: session 
    });
    if (!agent.session?.did || agent.session.did !== session.sub) {
        console.error('oauthSessionToAccount: BskyAgent did not initialize correctly.');
        try {
            const fallbackAgent = new BskyAgent({ service: BLUESKY_SERVICE });
            const { data: profile } = await fallbackAgent.getProfile({ actor: session.sub });
            const account: Account = {
              did: session.sub, 
              handle: profile.handle, 
              refreshJwt: session.refresh_token, 
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
    const { data: profile } = await agent.getProfile({ actor: agent.session.did });
    const account: Account = {
      did: agent.session.did, 
      handle: profile.handle, 
      refreshJwt: agent.session.refreshJwt!, 
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

// REMOVED Manual PKCE Helper functions

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // Effect to handle OAuth callback via init() when the component loads/reloads
  useEffect(() => {
    const processOAuthCallback = async () => {
      // Check if the URL hash contains parameters - indicating a redirect back
      if (window.location.hash.includes('#code=') || window.location.hash.includes('#error=') || window.location.hash.includes('#state=')) {
        setLoading(true); 
        setInfo('Processing login callback...');
        setError(null);
        console.log('OAuth callback fragment detected. Initializing client...');
        
        // Instantiate client to process the callback
        const oauthClient = new BrowserOAuthClient({ 
            clientMetadata, 
            handleResolver: BLUESKY_SERVICE, 
            responseMode: 'fragment' // Match the mode used
        });

        try {
          // init() parses the URL fragment, exchanges code, validates state/PKCE
          const result = await oauthClient.init(); 
          
          if (result && result.session) {
            console.log('Client init successful. Session obtained for:', result.session.sub);
            const account = await oauthSessionToAccount(result.session);
            if (account) {
              console.log('Account created:', account.handle);
              setInfo(`Welcome ${account.handle}! Finalizing...`);
              await browser.runtime.sendMessage({
                  type: 'ACCOUNT_ADDED',
                  data: { account }
              });
              console.log('ACCOUNT_ADDED message sent to background.');
              setTimeout(() => window.close(), 1500); 
            } else {
              setError('Failed to process session data after login.');
              setInfo(null);
            }
          } else {
             // Handle cases where init() fails or doesn't return a session
             const hashParams = new URLSearchParams(window.location.hash.substring(1));
             const errorCode = hashParams.get('error');
             const errorDesc = hashParams.get('error_description') || 'Unknown error during callback processing.';
             if (errorCode) {
                 console.error(`OAuth Error from callback fragment: ${errorCode} - ${errorDesc}`);
                 setError(`Login failed: ${errorDesc}`);
             } else {
                 console.warn('oauthClient.init() did not return a session after callback detection.', result);
                 setError('Failed to initialize session from callback.');
             }
             setInfo(null);
          }
        } catch (err: any) {
          console.error('Error during OAuth init/callback processing:', err);
          setError(`An error occurred during login processing: ${err.message || err}`);
          setInfo(null);
        } finally {
          setLoading(false);
          // Clean the URL hash after processing?
          // window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
        }
      } else {
          console.log('No OAuth callback fragment detected on load.');
          setInfo(null); // Clear any previous info message
      }
    };

    processOAuthCallback();
  }, []); // Run once on mount/load

  // Handle initiating the OAuth sign-in flow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('handleOAuthLogin started (direct signIn)');
    if (!handle) {
      setError('Please enter your Bluesky handle (e.g., yourname.bsky.social).');
      return;
    }
    setError(null);
    setInfo('Redirecting to Bluesky for login...'); 
    setLoading(true);
    
    try {
        const state = crypto.randomUUID(); // Generate unique state for this request
        console.log('Generated state for OAuth flow:', state);
        
        console.log('Creating BrowserOAuthClient...'); 
        // Instantiate client with embedded metadata using extension redirect URI
        const oauthClient = new BrowserOAuthClient({ 
            clientMetadata, // Contains EXTENSION_REDIRECT_URL
            handleResolver: BLUESKY_SERVICE, 
            responseMode: 'fragment' 
        });
        
        console.log('Calling await oauthClient.signIn() with state...');
        // Let the client handle PKCE generation/storage and redirect
        await oauthClient.signIn(handle.trim(), { state });
        
        // This part might not be reached unless signIn throws an immediate error
        console.log('signIn call completed without throwing (redirect expected)...'); 

    } catch (err: any) {
      // Catch immediate errors from signIn (like misconfiguration, network fail before redirect)
      // The "User navigated back" error might still happen here
      console.error('OAuth signIn initiation error:', err); 
      setError(`Failed to start login: ${err.message || err}`);
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
           You will be redirected to Bluesky to authorize Notisky.
        </p>
      </div>
    </div>
  );
}

export default Login; 