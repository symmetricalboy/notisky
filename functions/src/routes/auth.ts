import express from 'express';

const authRouter = express.Router();

// Note: Removed imports for UserModel, NotificationManager, BskyAgent etc. 
// as they are not directly used in these two specific routes.
// Add them back if you expand this function to handle more.

// Route for extension to initiate the OAuth flow
// Handles GET requests to /api/auth/ext-auth
authRouter.get('/ext-auth', async (req, res) => {
  console.log('[CloudFunc] /ext-auth received request');
  // Extract query parameters sent by the extension
  const { extension_id, code_challenge, state } = req.query;

  if (!extension_id || typeof extension_id !== 'string' || 
      !code_challenge || typeof code_challenge !== 'string' || 
      !state || typeof state !== 'string') {
    console.error('[CloudFunc] /ext-auth missing required params:', req.query);
    return res.status(400).send(`
      <html><head><title>Authentication Error</title></head>
      <body><h1>Authentication Error</h1>
      <p>Missing required parameters: extension_id, code_challenge, and state are required.</p>
      </body></html>`);
  }

  // Store extension ID in a temporary cookie for the callback to retrieve.
  // Use httpOnly and secure flags in production. Max age 5 mins.
  res.cookie('notiskyExtensionId', extension_id, { 
    maxAge: 5 * 60 * 1000, 
    httpOnly: true, 
    secure: !req.hostname.includes('localhost'), // Secure only if not localhost
    sameSite: 'lax' // Use lowercase 'lax'
  });
  console.log(`[CloudFunc] /ext-auth stored extension ID in cookie: ${extension_id}`);

  // Construct the redirect URI to *this function's* extension callback handler
  // Use the function's own URL. Need a way to determine this dynamically or set via env var.
  // TODO: Replace with dynamic URL or environment variable for production!
  const isLocal = req.hostname.includes('localhost') || req.hostname.includes('127.0.0.1');
  const functionBaseUrl = isLocal ? `http://${req.get('host')}` : `https://${req.get('host')}`; // Basic detection
  const redirectUri = `${functionBaseUrl}/notiskyAuth/api/auth/extension-callback`; // Assumes function root handles /api/auth

  console.log(`[CloudFunc] /ext-auth determined redirect URI: ${redirectUri}`);

  // Construct the auth URL for Bluesky
  const authUrlParams = new URLSearchParams({
    response_type: 'code',
    // This is the public Client ID URL registered with Bluesky
    client_id: 'https://notisky.symm.app/public/client-metadata/client.json',
    redirect_uri: redirectUri,
    state: state,
    scope: 'atproto transition:generic transition:chat.bsky', // Request necessary scopes
    code_challenge: code_challenge,
    code_challenge_method: 'S256'
  });

  // Embed extension_id within the state parameter (JSON object) 
  // as cookie method might not always work depending on browser settings.
  let stateObj: Record<string, any> = { originalState: state, extensionId: extension_id };
  authUrlParams.set('state', JSON.stringify(stateObj));
  console.log('[CloudFunc] /ext-auth enhanced state param with extension ID');

  const blueskyAuthUrl = `https://bsky.social/oauth/authorize?${authUrlParams.toString()}`;

  console.log(`[CloudFunc] /ext-auth Redirecting to Bluesky OAuth: ${blueskyAuthUrl}`);

  // Redirect the user's browser to Bluesky OAuth
  return res.redirect(blueskyAuthUrl);
});

// Extension callback endpoint to handle OAuth callbacks from Bluesky
// Handles GET requests to /api/auth/extension-callback
authRouter.get('/extension-callback', async (req, res) => {
  console.log('[CloudFunc] /extension-callback received request');
  try {
    // Get authorization code and state from the Bluesky callback
    const { code, state, error } = req.query;

    console.log('[CloudFunc] /extension-callback received:', {
      code: code ? `${String(code).substring(0, 5)}...` : 'none',
      state: state ? `${String(state).substring(0, 5)}...` : 'none',
      error
    });

    if (error || !code || typeof code !== 'string' || !state || typeof state !== 'string') {
      const errorMsg = error || 'Missing code or state';
      console.error('[CloudFunc] /extension-callback OAuth error or missing params:', errorMsg, req.query);
      // Render generic error page - can't reliably message extension here
      return res.status(400).send(`
        <html><head><title>Authentication Error</title></head>
        <body><h1>Authentication Error</h1>
        <p>There was an error during authentication: ${errorMsg}</p>
        <p>Please close this window and try again from the extension.</p>
        <details><summary>Debug Info</summary><pre>${JSON.stringify(req.query)}</pre></details>
        </body></html>`);
    }

    // Attempt to extract extension ID primarily from the state parameter
    let extensionId: string | undefined;
    let originalState: string = state; // Default to using the full state if parsing fails
    try {
      const stateObj = JSON.parse(state);
      if (stateObj && typeof stateObj.extensionId === 'string') {
        extensionId = stateObj.extensionId;
        originalState = stateObj.originalState || state; // Use original state if present
        console.log(`[CloudFunc] /extension-callback Extracted extension ID from state: ${extensionId}`);
      }
    } catch (e) {
      console.warn('[CloudFunc] /extension-callback Could not parse state as JSON:', state);
      // Fallback: Check cookie (less reliable)
      if (req.cookies && req.cookies.notiskyExtensionId) {
        extensionId = req.cookies.notiskyExtensionId;
        console.log(`[CloudFunc] /extension-callback Using extension ID from cookie fallback: ${extensionId}`);
        // Clear the cookie
        res.clearCookie('notiskyExtensionId');
      }
    }

    if (!extensionId) {
       console.error('[CloudFunc] /extension-callback Could not determine target extension ID.');
       return res.status(400).send(`
        <html><head><title>Authentication Error</title></head>
        <body><h1>Authentication Error</h1>
        <p>Could not identify the target browser extension.</p>
        <p>Please close this window and try the authentication process again from the extension.</p>
        </body></html>`);
    }

    // Render HTML page with JavaScript to send message back to the extension
    // Pass the ORIGINAL state back to the extension for verification
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authenticating...</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .card { background: #f5f5f7; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          #status { margin-top: 15px; font-weight: bold; }
          .success { color: #2e7d32; }
          .error { color: #e53935; }
        </style>
        </head>
        <body>
          <div class="card">
            <h1>Finishing Authentication</h1>
            <p>Please wait while we securely finish the authentication process.</p>
            <div id="status">Contacting extension...</div>
            <noscript><p class="error">JavaScript is required to complete authentication.</p></noscript>
          </div>
          <script>
            (function() {
              const statusEl = document.getElementById('status');
              try {
                const code = "${encodeURIComponent(code)}";
                const state = "${encodeURIComponent(originalState)}"; // Send original state back
                const extensionId = "${extensionId}"; 

                if (!code || !state || !extensionId) {
                   throw new Error("Missing critical parameters in script.");
                }

                const message = {
                  type: 'oauthCallback',
                  data: {
                    code: decodeURIComponent(code),
                    state: decodeURIComponent(state) // Decode original state
                  }
                };

                statusEl.textContent = 'Sending authentication code to extension (' + extensionId.substring(0, 8) + ')...';
                console.log('Sending message to extension:', extensionId, message);

                if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
                   browser.runtime.sendMessage(extensionId, message, function(response) {
                    if (browser.runtime.lastError) {
                      console.error('Error sending message:', browser.runtime.lastError);
                      statusEl.textContent = 'Error: Could not communicate with the extension. Is it installed and enabled? (' + browser.runtime.lastError.message + ')';
                      statusEl.className = 'error';
                    } else {
                      console.log('Message sent successfully, response:', response);
                      statusEl.textContent = 'Authentication successful! You can close this window.';
                      statusEl.className = 'success';
                      setTimeout(() => window.close(), 1500);
                    }
                  });
                } else {
                   statusEl.textContent = 'Error: Cannot detect browser extension environment. Please ensure this page was opened by the Notisky extension.';
                   statusEl.className = 'error';
                   console.error('browser.runtime.sendMessage is not available.');
                }
              } catch (err) {
                console.error('Script error:', err);
                statusEl.textContent = 'An unexpected error occurred: ' + err.message;
                statusEl.className = 'error';
              }
            })();
          </script>
        </body>
      </html>
    `);

  } catch (error: any) {
    console.error('[CloudFunc] /extension-callback Server error:', error);
    return res.status(500).send(`
     <html><head><title>Server Error</title></head><body><h1>Server Error</h1><p>An unexpected server error occurred. Please try again later.</p></body></html>
    `);
  }
});

export default authRouter; 